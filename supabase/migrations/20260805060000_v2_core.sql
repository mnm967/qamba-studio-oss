-- v2 core: projects, episodes (extended), assets registry, bible.
-- Additive next to the v1 tables; RLS matches the v1 single-user open posture
-- (owner_id columns exist so auth can tighten policies later without DDL).

create extension if not exists moddatetime with schema extensions;

-- ---------------------------------------------------------------------------
-- projects: the medium-aware root (film | series | music_video)
-- ---------------------------------------------------------------------------
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  medium text not null check (medium in ('film','series','music_video')),
  title text not null,
  logline text,
  genre text[] not null default '{}',
  style text,                                  -- 'anime' | 'live_action' | ...
  aspect text not null default '16:9',
  size_id text not null default '720p',
  fps int not null default 24,
  status text not null default 'draft',
  director_persona jsonb,
  settings jsonb not null default '{}',
  cover_asset_id uuid,                         -- FK added below, after assets
  v1_series_id uuid,                           -- provenance for migrated rows
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger projects_updated before update on projects
  for each row execute procedure extensions.moddatetime(updated_at);

-- ---------------------------------------------------------------------------
-- episodes: extended in place. Every project gets >=1 episode (film/MV use a
-- single code 'MAIN'); v1 rows keep series_id and gain project_id on migrate.
-- ---------------------------------------------------------------------------
alter table episodes
  add column if not exists project_id uuid references projects(id) on delete cascade,
  add column if not exists idx int not null default 0,
  add column if not exists synopsis text,
  add column if not exists updated_at timestamptz not null default now();
create index if not exists episodes_project_idx on episodes (project_id, idx);

-- ---------------------------------------------------------------------------
-- assets: the B2 object registry — GC authority; clips indirect through it
-- ---------------------------------------------------------------------------
create table if not exists assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete set null,  -- null = global
  kind text not null check (kind in ('image','video','audio','frame','render','file')),
  b2_key text not null unique,
  content_type text,
  bytes bigint,
  width int,
  height int,
  duration_ms int,
  fps numeric,
  origin text not null default 'generated' check (origin in ('generated','uploaded','derived')),
  source_job_id uuid,
  meta jsonb not null default '{}',            -- prompt, model, seed, waveform peaks…
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists assets_proj_kind_idx on assets (project_id, kind, created_at desc);
create index if not exists assets_tags_idx on assets using gin (tags);

alter table projects
  add constraint projects_cover_asset_fk
  foreign key (cover_asset_id) references assets(id) on delete set null;

-- ---------------------------------------------------------------------------
-- bible: characters / environments / props / style / lore with confirmed
-- evolution history and ordered reference-image slots
-- ---------------------------------------------------------------------------
create table if not exists bible_entries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null check (kind in ('character','environment','prop','style','lore')),
  name text not null,
  summary text,
  doc jsonb not null default '{}',             -- appearance, personality, arc, wardrobe, palette
  identity_line text,                          -- verbatim 6–8-attribute sentence for H3 prompts
  voice_ref_asset_id uuid references assets(id) on delete set null,
  status text not null default 'draft' check (status in ('draft','confirmed')),
  version int not null default 1,
  v1_reference_id uuid,                        -- provenance for migrated rows
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, kind, name)
);
create trigger bible_entries_updated before update on bible_entries
  for each row execute procedure extensions.moddatetime(updated_at);

create table if not exists bible_revisions (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references bible_entries(id) on delete cascade,
  version int not null,
  doc jsonb not null,
  identity_line text,
  change_note text,
  proposed_by text not null default 'director',
  confirmed_at timestamptz,                    -- null until the user confirms
  created_at timestamptz not null default now(),
  unique (entry_id, version)
);

create table if not exists bible_assets (
  entry_id uuid not null references bible_entries(id) on delete cascade,
  asset_id uuid not null references assets(id) on delete cascade,
  role text not null default 'ref' check (role in ('ref','face','full_body','side','outfit','master')),
  slot int not null default 0,
  primary key (entry_id, asset_id)
);

-- ---------------------------------------------------------------------------
-- RLS: enabled, open to public (single-user posture, matches v1)
-- ---------------------------------------------------------------------------
alter table projects enable row level security;
alter table assets enable row level security;
alter table bible_entries enable row level security;
alter table bible_revisions enable row level security;
alter table bible_assets enable row level security;

do $$
declare t text;
begin
  foreach t in array array['projects','assets','bible_entries','bible_revisions','bible_assets'] loop
    execute format('create policy %I_select on %I for select to public using (true)', t, t);
    execute format('create policy %I_insert on %I for insert to public with check (true)', t, t);
    execute format('create policy %I_update on %I for update to public using (true) with check (true)', t, t);
    execute format('create policy %I_delete on %I for delete to public using (true)', t, t);
  end loop;
end $$;

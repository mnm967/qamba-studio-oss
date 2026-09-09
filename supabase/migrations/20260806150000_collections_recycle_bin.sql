-- Library collections + recycle bin.
--
-- Collections are user-made groupings of registry rows, filled by dragging
-- cards onto them. A collection is a VIEW over `assets`, never a second copy of
-- it (invariant #2: `assets` stays the one registry of every B2 object), so an
-- asset can sit in many collections and dropping it into one moves no bytes.
--
-- The bin is a SOFT delete, and it has to be. `gc_sweep` (worker/handlers/post.py)
-- treats any B2 object with no `assets` row as garbage and purges it after the
-- safety window — so a bin built on row deletion would have the sweep quietly
-- destroy the media while the UI still offered to restore it. Keeping the row
-- with `deleted_at` set leaves the registry complete and the media safe;
-- emptying the bin is the existing hard delete, DB row first and then B2.

-- ---------------------------------------------------------------------------
-- collections
-- ---------------------------------------------------------------------------
create table if not exists collections (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,  -- null = global
  name text not null,
  color text,                                  -- optional swatch, UI only
  idx int not null default 0,                  -- sidebar order
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists collections_project_idx on collections (project_id, idx, created_at);

drop trigger if exists collections_updated on collections;
create trigger collections_updated before update on collections
  for each row execute procedure extensions.moddatetime(updated_at);

-- Membership. Cascades both ways: dropping a collection unfiles its assets and
-- destroys nothing; purging an asset takes its memberships with it.
create table if not exists collection_assets (
  collection_id uuid not null references collections(id) on delete cascade,
  asset_id uuid not null references assets(id) on delete cascade,
  idx int not null default 0,                  -- manual order within a collection
  added_at timestamptz not null default now(),
  primary key (collection_id, asset_id)
);
create index if not exists collection_assets_asset_idx on collection_assets (asset_id);

-- ---------------------------------------------------------------------------
-- recycle bin
-- ---------------------------------------------------------------------------
alter table assets add column if not exists deleted_at timestamptz;
-- Partial: the bin is the small set, and every browse query is the other side
-- of this predicate (`deleted_at is null`).
create index if not exists assets_deleted_idx on assets (deleted_at desc)
  where deleted_at is not null;

-- ---------------------------------------------------------------------------
-- RLS: enabled, open to public — same single-user posture as the v2 core
-- ---------------------------------------------------------------------------
alter table collections enable row level security;
alter table collection_assets enable row level security;

do $$
declare t text;
begin
  foreach t in array array['collections','collection_assets'] loop
    begin
      execute format('create policy %I_select on %I for select to public using (true)', t, t);
      execute format('create policy %I_insert on %I for insert to public with check (true)', t, t);
      execute format('create policy %I_update on %I for update to public using (true) with check (true)', t, t);
      execute format('create policy %I_delete on %I for delete to public using (true)', t, t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- Realtime: the sidebar counts and the grid both live-update on these.
do $$
declare t text;
begin
  foreach t in array array['collections','collection_assets'] loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

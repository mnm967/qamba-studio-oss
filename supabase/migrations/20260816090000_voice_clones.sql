-- Cloned voices: a stored reference clip + a provider + whatever that provider
-- calls the voice it made from it.
--
-- WHY A TABLE AND NOT A FIELD ON `bible_entries`. A character's voice already
-- lives there (`doc.el_voice_id`), and that is right for a character — but a
-- clone is not a character. It is made once from a recording, it outlives the
-- episode it was made for, and the same clone is routinely wanted for a
-- narrator, a second character and a one-off line in the studio panel. Putting
-- it on the entry would mean re-uploading the same sample per character and
-- would give the studio panel nothing to list at all.
--
-- WHY IT IS PROVIDER-KEYED RATHER THAN A FISH ID. Two providers can clone and
-- they mean different things by it: Fish's hosted API REGISTERS a voice and
-- hands back an id, while s2-pro is zero-shot and needs no registration — the
-- reference clip itself is the voice, at synthesis time. `provider` +
-- `reference_id` (nullable) covers both, and `status` is what tells a UI
-- whether a hosted registration has come back yet. A schema that assumed one
-- id would have made the local path a special case forever.
--
-- `project_id` is NULLABLE on purpose, which is unusual here. A clone made
-- from a project's panel belongs to that project (so a collaborator on a share
-- can use it); one made without a project is personal and owner-only, which is
-- what the trigger's root fallback already produces. Both are useful and the
-- policies below handle them with no branch.
create table if not exists voice_clones (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  project_id uuid,
  name text not null,
  -- 'fish' = Fish Audio's hosted API (registered, has a reference_id);
  -- 'fish-local' = s2-pro on the pod (zero-shot, the sample IS the voice);
  -- 'elevenlabs' = IVC, and the only one whose id can be cast onto a
  -- character (see 20260816120000_voice_clones_elevenlabs.sql).
  provider text not null check (provider in ('fish', 'fish-local', 'elevenlabs')),
  reference_id text,
  -- The recording. ON DELETE SET NULL rather than CASCADE: a hosted clone
  -- still works after its sample is binned (the provider holds its own copy),
  -- and destroying the voice because someone tidied the library would be a
  -- surprising amount of damage for a delete.
  sample_asset_id uuid references assets(id) on delete set null,
  -- What is said in the sample. Fish's registration takes it and matches
  -- noticeably better with it; s2-pro uses it as the reference transcript.
  sample_text text,
  status text not null default 'pending' check (status in ('pending', 'ready', 'error')),
  error_msg text,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists voice_clones_project_scope_idx on voice_clones (project_id);
create index if not exists voice_clones_owner_idx on voice_clones (owner_id);

drop trigger if exists voice_clones_updated on voice_clones;
create trigger voice_clones_updated before update on voice_clones
  for each row execute procedure extensions.moddatetime(updated_at);

-- The ownership machinery, applied to exactly this table. `neon_owned_tables()`
-- and the parent map in 20260812190000_accounts.sql name it too — that file is
-- the source both `src/lib/ownership.test.ts` and the installers below read, so
-- a table added in only one of the two places fails the guard test rather than
-- shipping with `using (true)`.
create or replace function public.neon_owned_tables()
returns text[]
language sql
immutable
as $$
  select array[
    -- v2
    'projects', 'episodes', 'assets', 'jobs', 'cost_ledger',
    'collections', 'collection_assets',
    'chat_threads', 'chat_messages',
    'bible_entries', 'bible_revisions', 'bible_assets',
    'storyboards', 'scenes', 'beats',
    'generation_blocks', 'block_takes', 'take_reviews', 'take_assemblies',
    'timelines', 'tracks', 'clips',
    'rag_documents', 'rag_chunks',
    'voice_clones',
    -- v1 (the legacy studio still holds the catch-all route)
    'series', 'shots', 'takes', 'references_', 'voices'
  ];
$$;

drop trigger if exists voice_clones_set_owner on voice_clones;
create trigger voice_clones_set_owner before insert on voice_clones
  for each row execute function public.set_row_owner('projects', 'project_id');

alter table voice_clones enable row level security;

drop policy if exists voice_clones_select on voice_clones;
create policy voice_clones_select on voice_clones for select to authenticated
  using (owner_id = auth.uid() or project_id in (select public.shared_projects('viewer')));
drop policy if exists voice_clones_insert on voice_clones;
create policy voice_clones_insert on voice_clones for insert to authenticated
  with check (owner_id = auth.uid() or project_id in (select public.shared_projects('editor')));
drop policy if exists voice_clones_update on voice_clones;
create policy voice_clones_update on voice_clones for update to authenticated
  using (owner_id = auth.uid() or project_id in (select public.shared_projects('editor')));
drop policy if exists voice_clones_delete on voice_clones;
create policy voice_clones_delete on voice_clones for delete to authenticated
  using (owner_id = auth.uid() or project_id in (select public.shared_projects('editor')));

-- A DELETE puts only the replica identity in the WAL, so `owner_id = auth.uid()`
-- cannot be evaluated and realtime drops the event for EVERYONE — "I deleted
-- the voice and it is still in the picker until I reload".
alter table voice_clones replica identity full;

do $do$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public'
       and tablename = 'voice_clones') then
    alter publication supabase_realtime add table voice_clones;
  end if;
end $do$;

-- Imported ComfyUI graphs: the Civitai hub's storage, and the contract a
-- custom workflow is executed through.
--
-- WHY THE GRAPH IS STORED TWICE. `ui_graph` is what ComfyUI's canvas can
-- reopen (positions, groups, notes, reroutes); `api_graph` is what `/prompt`
-- executes. They are different documents, not two spellings of one, and the
-- round trip needs both: a user fixes the graph in ComfyUI's editor, which
-- only speaks UI format, and the pod runs the API one. Deriving either from
-- the other on demand is what `workflowAdapter.uiToApi` does on import, and it
-- is lossy in the UI direction (a converted graph has no layout at all), so
-- throwing the UI form away would mean "Open in ComfyUI" reopens a pile of
-- nodes stacked at the origin.
--
-- WHY `slots` IS A COLUMN AND NOT A FUNCTION. The tagger reads a graph and
-- guesses which node takes the prompt; a human can then correct it. Once
-- corrected, that correction IS the truth about this graph and must survive
-- re-tagging, a library upgrade, and a smarter detector shipping next month.
-- Re-deriving slots at render time would silently discard it.
--
-- SCOPE. Project-rooted like everything else (the PROJECT is the unit of
-- sharing), but `project_id` is NULLABLE here, unlike a scene or a beat: a
-- workflow is a tool rather than a piece of the film, and a null project means
-- "mine, everywhere". The share policies already read `project_id`, so a null
-- one is simply never shared — which is the correct default for a graph that
-- names filenames on the importer's own disk.

create table if not exists custom_workflows (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,

  name text not null,
  -- the model_map key this graph is FOR ('minimax-h3', 'wan2.2', …), so the
  -- picker can offer it where that model is chosen. Free text: an imported
  -- graph may target something the studio has no entry for, and refusing the
  -- import over a vocabulary mismatch would be worse than storing the string.
  base_model text,
  source text not null default 'import'
    check (source in ('import', 'civitai', 'comfyui', 'paste', 'file')),
  source_url text,
  -- civitai's ids, so a re-import updates rather than duplicating
  civitai_model_id bigint,
  civitai_version_id bigint,

  ui_graph jsonb,
  api_graph jsonb not null,
  slots jsonb not null default '{}'::jsonb,
  -- what the graph needs, computed at import: class names and model filenames.
  -- Stored rather than recomputed so the pre-flight check can run without
  -- parsing every graph in the library.
  requirements jsonb not null default '{}'::jsonb,

  status text not null default 'draft'
    check (status in ('draft', 'ready', 'error')),
  -- the last failure, verbatim: node id, class, and ComfyUI's own message. The
  -- whole point of the repair loop is that this is specific enough to act on.
  last_error jsonb,
  last_tested_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists custom_workflows_owner_idx on custom_workflows (owner_id);
create index if not exists custom_workflows_project_scope_idx on custom_workflows (project_id);
create index if not exists custom_workflows_model_idx on custom_workflows (base_model);
-- A re-import of the same Civitai version updates the row it already has.
-- Partial, because everything hand-made or pasted has a null version id and
-- several of those must be allowed to coexist.
create unique index if not exists custom_workflows_civitai_uniq
  on custom_workflows (owner_id, civitai_version_id)
  where civitai_version_id is not null;

drop trigger if exists custom_workflows_updated on custom_workflows;
create trigger custom_workflows_updated before update on custom_workflows
  for each row execute procedure extensions.moddatetime(updated_at);

-- Ownership is DERIVED, never passed (accounts migration). The parent chain is
-- `projects.project_id`; with a null project the trigger falls through to
-- auth.uid(), which is exactly right for an account-wide workflow.
drop trigger if exists custom_workflows_owner on custom_workflows;
create trigger custom_workflows_owner before insert on custom_workflows
  for each row execute function public.set_row_owner('projects', 'project_id');

-- `neon_owned_tables()` is the canonical registry and lives in the accounts
-- migration, which has already run — so the list is amended there (for
-- src/lib/ownership.test.ts, which reads that file as the source of truth) and
-- the function is replaced here so a database that is already up gets it too.
create or replace function public.neon_owned_tables()
returns text[]
language sql
immutable
as $$
  select array[
    'projects', 'episodes', 'assets', 'jobs', 'cost_ledger',
    'collections', 'collection_assets',
    'chat_threads', 'chat_messages',
    'bible_entries', 'bible_revisions', 'bible_assets',
    'storyboards', 'scenes', 'beats',
    'generation_blocks', 'block_takes', 'take_reviews', 'take_assemblies',
    'timelines', 'tracks', 'clips',
    'rag_documents', 'rag_chunks',
    'custom_workflows',
    'series', 'shots', 'takes', 'references_', 'voices'
  ];
$$;

alter table custom_workflows enable row level security;

-- Reads for viewers, writes for editors — the same shape the share migration
-- installs on every owned table. An account-wide workflow (project_id null)
-- matches neither share clause, so it stays private to its owner.
drop policy if exists custom_workflows_select on custom_workflows;
create policy custom_workflows_select on custom_workflows for select to authenticated
  using (owner_id = auth.uid()
         or project_id in (select public.shared_projects('viewer')));

drop policy if exists custom_workflows_insert on custom_workflows;
create policy custom_workflows_insert on custom_workflows for insert to authenticated
  with check (owner_id = auth.uid()
              or project_id in (select public.shared_projects('editor')));

drop policy if exists custom_workflows_update on custom_workflows;
create policy custom_workflows_update on custom_workflows for update to authenticated
  using (owner_id = auth.uid()
         or project_id in (select public.shared_projects('editor')))
  with check (owner_id = auth.uid()
              or project_id in (select public.shared_projects('editor')));

drop policy if exists custom_workflows_delete on custom_workflows;
create policy custom_workflows_delete on custom_workflows for delete to authenticated
  using (owner_id = auth.uid()
         or project_id in (select public.shared_projects('editor')));

-- Live, because a workflow imported on the desktop app has to appear in the
-- browser tab that is already open, and because "Sync to Qamba" from ComfyUI
-- lands as an UPDATE the user is waiting on. Added to the publication AND to
-- src/hooks/realtimeTables.ts — a table bound by a hook but absent from the
-- publication silently kills the whole shared channel.
do $do$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and tablename = 'custom_workflows'
  ) then
    alter publication supabase_realtime add table custom_workflows;
  end if;
end $do$;

-- A DELETE puts only the replica identity in the WAL, so `owner_id` cannot be
-- evaluated and the event is dropped for everyone — "I deleted it and it is
-- still in the list until I reload".
alter table custom_workflows replica identity full;

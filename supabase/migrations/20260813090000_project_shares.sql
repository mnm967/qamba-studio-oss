-- Collaboration: a project can be shared with another studio account, as a
-- viewer or an editor.
--
-- THE PROJECT IS THE UNIT, and that is a fact about the schema rather than a
-- preference. Twelve tables are cleanly episode-rooted (storyboards -> scenes
-- -> beats -> generation_blocks -> block_takes, timelines -> tracks -> clips),
-- but eight are project-only with nowhere sensible to put an episode:
-- `bible_entries`, `bible_assets`, `assets`, `collections`, `cost_ledger`,
-- `rag_documents`. A character's face sheet belongs to the series, not to
-- episode 2 — measured here: AFTERLIGHT is 3 episodes over 22 shared bible
-- entries and 849 project assets, STATIC 2 over 31. "Share episode 2" would
-- therefore have to hand over the same bible rows episodes 1 and 3 use, i.e.
-- quietly become a project share for everything that matters, or carry a
-- computed closure that goes stale the moment a character is added.
--
-- Access is granted to an ACCOUNT, never to a link: sign-in stays invite-only
-- (`allowed_emails` + the auth.users gate), so a share cannot become a second
-- way into the studio that the guest list does not govern.

-- ---------------------------------------------------------------------------
-- the grants
-- ---------------------------------------------------------------------------
create table if not exists project_shares (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer' check (role in ('viewer', 'editor')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index if not exists project_shares_user_idx on project_shares (user_id);

alter table project_shares enable row level security;

-- ---------------------------------------------------------------------------
-- `project_id` on every owned table: the scope key the policies read.
--
-- Denormalized for the same reason `owner_id` is — a policy on `beats` would
-- otherwise have to join beats -> scenes -> storyboards -> episodes on every
-- row of a storyboard page. One indexed uuid instead, filled by the same
-- trigger that already walks the parent chain.
--
-- Deliberately NOT a foreign key: it is a cache of a path whose real integrity
-- is already enforced by the parent FK the trigger followed, and every one of
-- these rows cascades away with that parent anyway. A second cascade path on
-- fifteen tables buys nothing and is one more thing to reason about on delete.
--
-- `series` gets the column and it stays NULL forever: v1 series predate
-- projects, so series-rooted rows (references_, voices, and shots/takes
-- reached through a v1 episode) are simply never shareable. Owner-only, which
-- is the honest answer for the legacy studio rather than a half-working one.
-- ---------------------------------------------------------------------------
do $do$
declare t text;
begin
  foreach t in array public.neon_owned_tables() loop
    continue when t = 'projects';   -- its own id IS the scope
    execute format('alter table public.%I add column if not exists project_id uuid', t);
    execute format('create index if not exists %I on public.%I (project_id)',
                   t || '_project_scope_idx', t);
  end loop;
end $do$;

-- ---------------------------------------------------------------------------
-- The trigger now derives BOTH keys from the parent, and is AUTHORITATIVE.
--
-- It used to fill `owner_id` only when the caller left it null. That was fine
-- while every row had exactly one possible owner; with sharing it is a hole —
-- an editor could insert into a shared project with `owner_id` set to
-- themselves and take a row inside someone else's project. When a parent
-- resolves, the parent decides, and what the caller passed is ignored. Roots
-- (a new project, a v1 series) still fall back to `auth.uid()`.
-- ---------------------------------------------------------------------------
create or replace function public.set_row_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  i int := 0;
  fk uuid;
  p_owner uuid;
  p_project uuid;
begin
  while i < TG_NARGS loop
    fk := nullif(to_jsonb(new) ->> TG_ARGV[i + 1], '')::uuid;
    if fk is not null then
      if TG_ARGV[i] = 'projects' then
        -- The parent IS the scope; a project has no project_id column.
        select p.owner_id, p.id into p_owner, p_project
          from public.projects p where p.id = fk;
      else
        execute format('select owner_id, project_id from public.%I where id = $1', TG_ARGV[i])
          into p_owner, p_project using fk;
      end if;
      -- The scope is overwritten whenever the parent knows it, NEVER merely
      -- defaulted. `project_id` is what the share policies read, so honouring a
      -- caller-supplied value would let an editor insert a scene into someone
      -- else's storyboard while labelling it with a project they do own — the
      -- WITH CHECK would pass and the row would land in the victim's tree.
      if p_project is not null then new.project_id := p_project; end if;
      -- Owner resolves at the first parent that HAS one. Keep walking
      -- otherwise: `assets` lists projects first and falls back to the job
      -- that produced it, and a project-less asset must still reach that.
      if p_owner is not null then
        new.owner_id := p_owner;
        return new;
      end if;
    end if;
    i := i + 2;
  end loop;
  -- A root, or a parent that is itself unowned (everything predating accounts,
  -- until the admin claim runs).
  new.owner_id := coalesce(new.owner_id, auth.uid());
  return new;
end;
$$;

-- `assets`, `jobs`, `collections`, `chat_threads`, `bible_entries`,
-- `cost_ledger` and `rag_documents` are inserted WITH a project_id but their
-- parent chain starts at `projects`, so the loop above already resolves them.
-- The remaining ones need the column backfilled for rows that already exist —
-- otherwise every pre-existing beat is out of scope and a share shows an empty
-- storyboard. Ordered parent-first so each level reads a filled parent.
update storyboards s set project_id = e.project_id from episodes e where e.id = s.episode_id and s.project_id is null;
update scenes      x set project_id = s.project_id from storyboards s where s.id = x.storyboard_id and x.project_id is null;
update beats       x set project_id = s.project_id from scenes s      where s.id = x.scene_id      and x.project_id is null;
update generation_blocks x set project_id = s.project_id from storyboards s where s.id = x.storyboard_id and x.project_id is null;
update block_takes    x set project_id = b.project_id from generation_blocks b where b.id = x.block_id and x.project_id is null;
update take_reviews   x set project_id = b.project_id from generation_blocks b where b.id = x.block_id and x.project_id is null;
-- …and then by storyboard, because a `sequence_review` has NO block: it judges
-- the assembled cut, so it carries storyboard_id and a null block_id. Following
-- only the block left 32 of 296 reviews unscoped — invisible in a shared
-- project, and invisible in this backfill too unless you count the nulls.
update take_reviews   x set project_id = s.project_id from storyboards s where s.id = x.storyboard_id and x.project_id is null;
update take_assemblies x set project_id = b.project_id from generation_blocks b where b.id = x.block_id and x.project_id is null;
update timelines   x set project_id = e.project_id from episodes e where e.id = x.episode_id and x.project_id is null;
update tracks      x set project_id = t.project_id from timelines t where t.id = x.timeline_id and x.project_id is null;
update clips       x set project_id = t.project_id from tracks t     where t.id = x.track_id    and x.project_id is null;
update bible_revisions x set project_id = b.project_id from bible_entries b where b.id = x.entry_id and x.project_id is null;
update bible_assets    x set project_id = b.project_id from bible_entries b where b.id = x.entry_id and x.project_id is null;
update collection_assets x set project_id = c.project_id from collections c where c.id = x.collection_id and x.project_id is null;
update chat_messages   x set project_id = t.project_id from chat_threads t where t.id = x.thread_id and x.project_id is null;
update rag_chunks      x set project_id = d.project_id from rag_documents d where d.id = x.document_id and x.project_id is null;
update shots       x set project_id = e.project_id from episodes e where e.id = x.episode_id and x.project_id is null;
update takes       x set project_id = s.project_id from shots s     where s.id = x.shot_id     and x.project_id is null;

-- ---------------------------------------------------------------------------
-- Who may I read / write?
--
-- Set-returning and STABLE so the planner evaluates it once per statement as an
-- InitPlan rather than per row — the difference between a storyboard page and a
-- storyboard page that times out. SECURITY DEFINER because `project_shares`'
-- own policy would otherwise have to be readable from inside every other
-- table's policy.
-- ---------------------------------------------------------------------------
create or replace function public.shared_projects(p_need text default 'viewer')
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.project_id from public.project_shares s
   where s.user_id = auth.uid()
     and (p_need <> 'editor' or s.role = 'editor');
$$;
grant execute on function public.shared_projects(text) to public;

/** The caller's role on a project: owner | editor | viewer | null. One call
 *  for the UI, so a viewer is shown a read-only surface instead of buttons
 *  that RLS will refuse. */
create or replace function public.project_role(p_project uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (select 1 from public.projects p
                  where p.id = p_project and p.owner_id = auth.uid()) then 'owner'
    else (select s.role from public.project_shares s
           where s.project_id = p_project and s.user_id = auth.uid())
  end;
$$;
grant execute on function public.project_role(uuid) to public;

-- ---------------------------------------------------------------------------
-- Policies: owner, or shared. Reads take any share; writes take an editor one.
-- ---------------------------------------------------------------------------
do $do$
declare t text; p record; scope text;
begin
  foreach t in array public.neon_owned_tables() loop
    continue when t in ('jobs', 'cost_ledger', 'rag_documents', 'rag_chunks');
    -- `projects` is its own scope.
    scope := case when t = 'projects' then 'id' else 'project_id' end;

    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;

    execute format(
      'create policy %I on public.%I for select to authenticated using '
      || '(owner_id = auth.uid() or %I in (select public.shared_projects(''viewer'')))',
      t || '_select', t, scope);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check '
      || '(owner_id = auth.uid() or %I in (select public.shared_projects(''editor'')))',
      t || '_insert', t, scope);
    execute format(
      'create policy %I on public.%I for update to authenticated using '
      || '(owner_id = auth.uid() or %I in (select public.shared_projects(''editor''))) '
      || 'with check (owner_id = auth.uid() or %I in (select public.shared_projects(''editor'')))',
      t || '_update', t, scope, scope);
    execute format(
      'create policy %I on public.%I for delete to authenticated using '
      || '(owner_id = auth.uid() or %I in (select public.shared_projects(''editor'')))',
      t || '_delete', t, scope);
  end loop;
end $do$;

-- jobs: an editor may queue work on a shared project (that IS collaborating),
-- and read the shared project's queue. Admins still read the whole queue.
-- Still no UPDATE — cancellation goes through request_job_cancel.
drop policy if exists jobs_select on jobs;
drop policy if exists jobs_insert on jobs;
drop policy if exists jobs_delete on jobs;
create policy jobs_select on jobs for select to authenticated
  using (owner_id = auth.uid()
         or public.is_admin()
         or project_id in (select public.shared_projects('viewer')));
create policy jobs_insert on jobs for insert to authenticated
  with check (owner_id = auth.uid()
              or project_id in (select public.shared_projects('editor')));
create policy jobs_delete on jobs for delete to authenticated
  using (kind = 'image'
         and (owner_id = auth.uid()
              or project_id in (select public.shared_projects('editor'))));

-- cost_ledger: a collaborator sees what the shared project cost. The rows are
-- still OWNED by the project owner — they are the one paying — so this is
-- visibility, not attribution. See `actor_id` below for who spent it.
drop policy if exists cost_ledger_select on cost_ledger;
drop policy if exists cost_ledger_insert on cost_ledger;
create policy cost_ledger_select on cost_ledger for select to authenticated
  using (owner_id = auth.uid()
         or public.is_admin()
         or project_id in (select public.shared_projects('viewer')));
create policy cost_ledger_insert on cost_ledger for insert to authenticated
  with check (owner_id = auth.uid()
              or project_id in (select public.shared_projects('editor')));

-- rag: a null owner is still GLOBAL grounding.
do $do$
declare t text;
begin
  foreach t in array array['rag_documents', 'rag_chunks'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using '
      || '(owner_id is null or owner_id = auth.uid() '
      || 'or project_id in (select public.shared_projects(''viewer'')))', t || '_select', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check '
      || '(owner_id = auth.uid() or project_id in (select public.shared_projects(''editor'')))',
      t || '_insert', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using '
      || '(owner_id = auth.uid() or project_id in (select public.shared_projects(''editor''))) '
      || 'with check (owner_id = auth.uid() '
      || 'or project_id in (select public.shared_projects(''editor'')))', t || '_update', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using '
      || '(owner_id = auth.uid() or project_id in (select public.shared_projects(''editor'')))',
      t || '_delete', t);
  end loop;
end $do$;

-- ---------------------------------------------------------------------------
-- project_shares itself: the OWNER manages the list; a collaborator may read
-- their own grant (so the UI can say "shared with you, as viewer") and may
-- remove it (leaving a project you were added to needs no permission).
-- ---------------------------------------------------------------------------
create policy project_shares_select on project_shares for select to authenticated
  using (user_id = auth.uid()
         or exists (select 1 from projects p
                     where p.id = project_id and p.owner_id = auth.uid()));
create policy project_shares_insert on project_shares for insert to authenticated
  with check (exists (select 1 from projects p
                       where p.id = project_id and p.owner_id = auth.uid()));
create policy project_shares_update on project_shares for update to authenticated
  using (exists (select 1 from projects p
                  where p.id = project_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from projects p
                       where p.id = project_id and p.owner_id = auth.uid()));
create policy project_shares_delete on project_shares for delete to authenticated
  using (user_id = auth.uid()
         or exists (select 1 from projects p
                     where p.id = project_id and p.owner_id = auth.uid()));

grant select, insert, update, delete on project_shares to authenticated;
grant all on project_shares to service_role;

-- Sharing is by ACCOUNT and the guest list still governs who has one, so the
-- share UI needs to resolve an address to a uid. `profiles` is readable only
-- for yourself, which is right — this is the narrow exception: an exact-email
-- lookup that returns nothing but the id, and only to someone who owns a
-- project to share.
create or replace function public.find_account(p_email text)
returns table (id uuid, email text, display_name text, avatar_url text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.email, p.display_name, p.avatar_url
    from public.profiles p
   where p.email = lower(trim(p_email))
     and exists (select 1 from public.projects x where x.owner_id = auth.uid())
   limit 1;
$$;
revoke execute on function public.find_account(text) from public, anon;
grant execute on function public.find_account(text) to authenticated;

-- ---------------------------------------------------------------------------
-- `cost_ledger.actor_id`: who spent it, next to who owns it.
--
-- `owner_id` on a ledger row is derived from the project, so a collaborator's
-- render books to the project owner — correct, they pay the bill. That leaves
-- "which of us started this" unanswerable, which is the first question anyone
-- asks about a shared project's spend.
-- ---------------------------------------------------------------------------
alter table cost_ledger add column if not exists actor_id uuid;
create index if not exists cost_ledger_actor_idx on cost_ledger (actor_id);

-- ---------------------------------------------------------------------------
-- Realtime: a collaborator's channel filter is fixed when it JOINS, so a share
-- granted or revoked mid-session changes nothing until they rejoin. Publishing
-- the table lets the client see its own grant appear/disappear and reset the
-- channel; `replica identity full` is what makes the REVOKE deliver at all.
-- ---------------------------------------------------------------------------
alter table project_shares replica identity full;
do $do$
begin
  alter publication supabase_realtime add table project_shares;
exception when duplicate_object then null;
end $do$;

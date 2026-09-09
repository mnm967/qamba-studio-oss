-- Accounts: Supabase Auth identities, per-owner data isolation, invite-only
-- signup, and the one-time adoption of everything that predates all of this.
--
-- The studio shipped single-user: RLS was enabled on every table and every
-- policy was `using (true)`, i.e. the anon key in the browser bundle WAS the
-- identity. This migration keeps that shape (RLS on, PostgREST straight from
-- the browser, invariant #1 untouched — work is still a `jobs` row) and only
-- changes what the policies read: `owner_id = auth.uid()` instead of `true`.
--
-- Three things make that survivable without touching a line of worker code:
--
--  1. The worker holds the SERVICE key, which carries `bypassrls` — every
--     handler keeps writing exactly as it does today.
--  2. `owner_id` is DERIVED, not passed. A BEFORE INSERT trigger walks the
--     row's own foreign keys to its parent and copies the parent's owner
--     (block_take -> generation_block -> storyboard -> episode -> project),
--     falling back to `auth.uid()` only at a root. So neither the worker nor
--     the 40-odd browser insert sites had to learn about ownership, and a
--     child inserted under someone else's parent gets THEIR owner id and is
--     then refused by the insert policy's WITH CHECK — cross-tenant writes
--     fail closed for free.
--  3. Nothing is backfilled here, because at migration time there are no
--     users to backfill to. Existing rows keep `owner_id = null` and are
--     adopted wholesale by the first admin to sign in (`claim_orphan_data`),
--     which is what "all the current stuff goes to the admin account" means.
--     Until that happens the data is invisible to the browser and untouched
--     in the database.
--
-- Signup is INVITE ONLY: `allowed_emails` is the guest list and a BEFORE
-- INSERT trigger on auth.users refuses anyone not on it. That gate is not
-- decoration — the render pod bills $3.3631/hr and hosted generation spends
-- the owner's ElevenLabs/Anthropic/OpenAI credit, so "anyone who finds the
-- URL can sign in with Google" is a spending vulnerability, not a UX choice.

-- ---------------------------------------------------------------------------
-- The canonical list of owned tables.
--
-- A function rather than a comment so the column adder, the trigger installer,
-- the policy rewriter and the orphan claim all read ONE list and cannot drift
-- apart. Three tables are deliberately absent because they are shared
-- infrastructure, not anyone's work: `model_catalog` (what the pod can run),
-- `pod_status` (the singleton the worker republishes every 5s) and
-- `job_timings` (ETA telemetry, already anonymous).
-- ---------------------------------------------------------------------------
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
    'custom_workflows', 'voice_clones',
    'film_shares', 'product_events',
    -- v1 (the legacy studio still holds the catch-all route)
    'series', 'shots', 'takes', 'references_', 'voices'
  ];
$$;

-- ---------------------------------------------------------------------------
-- profiles + the guest list
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  role text not null default 'member' check (role in ('member', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists profiles_updated on profiles;
create trigger profiles_updated before update on profiles
  for each row execute procedure extensions.moddatetime(updated_at);

create table if not exists allowed_emails (
  email text primary key,
  role text not null default 'member' check (role in ('member', 'admin')),
  note text,
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- THE OWNER SEED IS NOT PART OF THIS BUILD. The cloud version inserted one
-- address here — by address rather than by uid, auth.users being empty at this
-- point — so that the first sign-in from it became the admin. There are no
-- accounts in this build and nothing applies these migrations to a database,
-- so the row is gone rather than left as somebody's email address in a public
-- repository. See ../README.md for why the file is still here at all.

-- SECURITY DEFINER on purpose, and it matters: `profiles`' own select policy
-- calls this, so an invoker-rights version would re-enter RLS on the table it
-- is being asked about and recurse.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;
-- Granted broadly on purpose: this is read by policies on `jobs`, and Realtime
-- evaluates those policies in its own session when deciding whether to deliver
-- a row. A function the checker cannot execute is a subscription that silently
-- delivers nothing. It leaks nothing either way — for anon it returns false.
grant execute on function public.is_admin() to public;

-- ---------------------------------------------------------------------------
-- owner_id: one nullable column per owned table, FK'd to the auth user.
--
-- ON DELETE CASCADE: removing an account removes its work. The alternative
-- (set null) leaves rows no policy can ever match again — invisible in the UI,
-- still counted by every `select count(*)`, and silently adopted by the next
-- admin who runs the orphan claim. An asset row cascading away is also the
-- correct media semantic here: `gc_sweep` purges any B2 object with no
-- `assets` row, so the bytes follow the row exactly as they do for a hard
-- delete from the recycle bin.
-- ---------------------------------------------------------------------------
do $do$
declare t text;
begin
  foreach t in array public.neon_owned_tables() loop
    execute format('alter table public.%I add column if not exists owner_id uuid', t);
    if not exists (
      select 1 from pg_constraint
       where conrelid = format('public.%I', t)::regclass
         and conname = t || '_owner_fk'
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (owner_id) '
        || 'references auth.users(id) on delete cascade', t, t || '_owner_fk');
    end if;
    execute format('create index if not exists %I on public.%I (owner_id)',
                   t || '_owner_idx', t);
  end loop;
end $do$;

-- ---------------------------------------------------------------------------
-- The derivation. One trigger function for every table; the parent chain
-- arrives as trigger arguments in (parent_table, local_fk_column) pairs, tried
-- in order, first hit wins.
--
-- A null result is legal and load-bearing in two places: a row the SERVICE key
-- writes with no resolvable parent stays unowned (which is what keeps the
-- seeded global craft guides in `rag_documents` global), and every pre-account
-- row already in the database is unowned until the admin claim runs.
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
  found uuid;
begin
  if new.owner_id is not null then
    return new;
  end if;
  -- to_jsonb rather than `($1).col` via EXECUTE: the column name is dynamic and
  -- this needs no plan cache games to read it off the NEW record.
  while i < TG_NARGS loop
    fk := nullif(to_jsonb(new) ->> TG_ARGV[i + 1], '')::uuid;
    if fk is not null then
      execute format('select owner_id from public.%I where id = $1', TG_ARGV[i])
        into found using fk;
      if found is not null then
        new.owner_id := found;
        return new;
      end if;
    end if;
    i := i + 2;
  end loop;
  new.owner_id := auth.uid();
  return new;
end;
$$;

do $do$
declare
  -- Absent from this map = a root: nothing to inherit from, owner is whoever
  -- is inserting. `jobs` lists five parents because a v1 job carries a shot /
  -- reference / take instead of a project, and `assets` falls back to the job
  -- that produced it for the same reason (handlers/legacy.py registers a
  -- reference image with a source_job_id and no project).
  spec jsonb := $j${
    "episodes":          ["projects", "project_id", "series", "series_id"],
    "assets":            ["projects", "project_id", "jobs", "source_job_id"],
    "jobs":              ["projects", "project_id", "episodes", "episode_id",
                          "shots", "shot_id", "references_", "reference_id",
                          "takes", "take_id"],
    "cost_ledger":       ["projects", "project_id", "jobs", "job_id"],
    "collections":       ["projects", "project_id"],
    "collection_assets": ["collections", "collection_id"],
    "chat_threads":      ["projects", "project_id", "episodes", "episode_id"],
    "chat_messages":     ["chat_threads", "thread_id"],
    "bible_entries":     ["projects", "project_id"],
    "bible_revisions":   ["bible_entries", "entry_id"],
    "bible_assets":      ["bible_entries", "entry_id"],
    "storyboards":       ["episodes", "episode_id"],
    "scenes":            ["storyboards", "storyboard_id"],
    "beats":             ["scenes", "scene_id"],
    "generation_blocks": ["storyboards", "storyboard_id"],
    "block_takes":       ["generation_blocks", "block_id"],
    "take_reviews":      ["generation_blocks", "block_id", "storyboards", "storyboard_id"],
    "take_assemblies":   ["generation_blocks", "block_id"],
    "timelines":         ["episodes", "episode_id"],
    "tracks":            ["timelines", "timeline_id"],
    "clips":             ["tracks", "track_id"],
    "rag_documents":     ["projects", "project_id"],
    "rag_chunks":        ["rag_documents", "document_id"],
    "custom_workflows":  ["projects", "project_id"],
    "voice_clones":      ["projects", "project_id"],
    "film_shares":       ["projects", "project_id"],
    "product_events":    ["projects", "project_id"],
    "shots":             ["episodes", "episode_id"],
    "takes":             ["shots", "shot_id"],
    "references_":       ["series", "series_id"],
    "voices":            ["series", "series_id"]
  }$j$::jsonb;
  t text;
  args text;
begin
  foreach t in array public.neon_owned_tables() loop
    select string_agg(quote_literal(v), ', ')
      into args
      from jsonb_array_elements_text(coalesce(spec -> t, '[]'::jsonb)) v;
    execute format('drop trigger if exists %I on public.%I', t || '_set_owner', t);
    execute format(
      'create trigger %I before insert on public.%I for each row '
      || 'execute function public.set_row_owner(%s)',
      t || '_set_owner', t, coalesce(args, ''));
  end loop;
end $do$;

-- ---------------------------------------------------------------------------
-- Adoption. Idempotent: it only ever touches rows nobody owns.
-- ---------------------------------------------------------------------------
create or replace function public.claim_orphan_data(p_owner uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := coalesce(p_owner, auth.uid());
  t text;
  n int;
  res jsonb := '{}'::jsonb;
begin
  if v_owner is null then
    raise exception 'claim_orphan_data: no owner (pass one, or call as a signed-in user)';
  end if;
  -- Callable by an admin (or by the worker/service key, which has no uid and
  -- must therefore name the owner).
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'claim_orphan_data: admin only' using errcode = '42501';
  end if;

  foreach t in array public.neon_owned_tables() loop
    -- rag_*: a null owner is GLOBAL there, not orphaned. The craft guides
    -- `scripts/seed_rag.py` layers in are project-less on purpose and
    -- `match_rag_chunks` already reads project-less as "applies to everyone";
    -- adopting them would take the shared grounding private.
    continue when t in ('rag_documents', 'rag_chunks');
    execute format('update public.%I set owner_id = $1 where owner_id is null', t)
      using v_owner;
    get diagnostics n = row_count;
    if n > 0 then res := res || jsonb_build_object(t, n); end if;
  end loop;

  update public.rag_documents set owner_id = v_owner
   where owner_id is null and project_id is not null;
  get diagnostics n = row_count;
  if n > 0 then res := res || jsonb_build_object('rag_documents', n); end if;

  update public.rag_chunks c set owner_id = v_owner
   where c.owner_id is null
     and exists (select 1 from public.rag_documents d
                  where d.id = c.document_id and d.owner_id = v_owner);
  get diagnostics n = row_count;
  if n > 0 then res := res || jsonb_build_object('rag_chunks', n); end if;

  return res;
end;
$$;
revoke execute on function public.claim_orphan_data(uuid) from public, anon;
grant execute on function public.claim_orphan_data(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Signup: the guest list is enforced in the database, so it holds for every
-- provider at once — Google, magic link, or anything added later — instead of
-- once per client flow.
-- ---------------------------------------------------------------------------
create or replace function public.neon_gate_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.allowed_emails where email = lower(new.email)
  ) then
    raise exception 'neon_not_invited: % is not on the studio invite list', new.email
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists neon_gate_signup on auth.users;
create trigger neon_gate_signup
  before insert on auth.users
  for each row execute function public.neon_gate_signup();

create or replace function public.neon_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_role text;
begin
  select a.role into v_role
    from public.allowed_emails a where a.email = lower(new.email);

  insert into public.profiles (id, email, display_name, avatar_url, role)
  values (
    new.id,
    lower(new.email),
    nullif(coalesce(new.raw_user_meta_data ->> 'full_name',
                    new.raw_user_meta_data ->> 'name'), ''),
    nullif(new.raw_user_meta_data ->> 'avatar_url', ''),
    coalesce(v_role, 'member')
  )
  on conflict (id) do update
    set email = excluded.email,
        display_name = coalesce(profiles.display_name, excluded.display_name),
        avatar_url = coalesce(excluded.avatar_url, profiles.avatar_url);

  -- The FIRST admin adopts everything that predates accounts. Guarded on being
  -- first so that inviting a second admin later does not hand them whatever
  -- happens to be unowned at that moment.
  if coalesce(v_role, 'member') = 'admin'
     and not exists (select 1 from public.profiles
                      where role = 'admin' and id <> new.id) then
    perform public.claim_orphan_data(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists neon_handle_new_user on auth.users;
create trigger neon_handle_new_user
  after insert on auth.users
  for each row execute function public.neon_handle_new_user();

-- ---------------------------------------------------------------------------
-- RLS. Every open `using (true)` policy is replaced, and the role narrows from
-- `public` (which includes anon — the key in the browser bundle) to
-- `authenticated`.
-- ---------------------------------------------------------------------------
do $do$
declare t text; p record;
begin
  foreach t in array (public.neon_owned_tables()
                      || array['profiles', 'allowed_emails', 'model_catalog',
                               'pod_status', 'job_timings']) loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;

  -- The general case: you see, write and delete your own rows and nobody
  -- else's. `jobs`, `cost_ledger` and the rag pair are handled after this loop.
  foreach t in array public.neon_owned_tables() loop
    continue when t in ('jobs', 'cost_ledger', 'rag_documents', 'rag_chunks');
    -- The policy name is its own %I argument, never `%I_select`: format() only
    -- adds quotes to an identifier that needs them, so appending outside the
    -- placeholder happens to work for every table here and would emit
    -- "Weird Name"_select for the first one that did need quoting.
    execute format('create policy %I on public.%I for select to authenticated '
                   || 'using (owner_id = auth.uid())', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated '
                   || 'with check (owner_id = auth.uid())', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated '
                   || 'using (owner_id = auth.uid()) with check (owner_id = auth.uid())',
                   t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated '
                   || 'using (owner_id = auth.uid())', t || '_delete', t);
  end loop;
end $do$;

-- jobs: same three verbs v1 had (no anon UPDATE — cancellation goes through
-- request_job_cancel so a client cannot rewrite status, priority or payload of
-- a running render), now scoped by owner. Admins additionally READ the whole
-- queue: the GPU is one shared machine, and "why is my job still queued" is
-- unanswerable without seeing what is ahead of it.
create policy jobs_select on jobs for select to authenticated
  using (owner_id = auth.uid() or public.is_admin());
create policy jobs_insert on jobs for insert to authenticated
  with check (owner_id = auth.uid());
create policy jobs_delete on jobs for delete to authenticated
  using (kind = 'image' and owner_id = auth.uid());

-- cost_ledger keeps its select+insert-only shape (the worker writes the rest).
create policy cost_ledger_select on cost_ledger for select to authenticated
  using (owner_id = auth.uid() or public.is_admin());
create policy cost_ledger_insert on cost_ledger for insert to authenticated
  with check (owner_id = auth.uid());

-- rag: an unowned document is shared grounding, readable by everyone, writable
-- by nobody but the service key.
do $do$
declare t text;
begin
  foreach t in array array['rag_documents', 'rag_chunks'] loop
    execute format('create policy %I on public.%I for select to authenticated '
                   || 'using (owner_id is null or owner_id = auth.uid())',
                   t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated '
                   || 'with check (owner_id = auth.uid())', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated '
                   || 'using (owner_id = auth.uid()) with check (owner_id = auth.uid())',
                   t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated '
                   || 'using (owner_id = auth.uid())', t || '_delete', t);
  end loop;
end $do$;

-- Shared infrastructure: readable by any signed-in account, written by the
-- service key only.
create policy model_catalog_select on model_catalog for select to authenticated using (true);
create policy pod_status_select   on pod_status   for select to authenticated using (true);
create policy job_timings_select  on job_timings  for select to authenticated using (true);

-- profiles: yours, plus admins see the roster (the invite screen lists who is in).
create policy profiles_select on profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_update on profiles for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());
create policy profiles_admin_delete on profiles for delete to authenticated
  using (public.is_admin() and id <> auth.uid());

-- `role` lives on the row the user is allowed to edit (they set their own
-- display name), so the update policy alone would let any member write
-- role = 'admin' onto themselves — RLS is row-level and cannot say "every
-- column but this one". A guard trigger can.
create or replace function public.neon_guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role and not public.is_admin() then
    raise exception 'only an admin can change an account role'
      using errcode = '42501';
  end if;
  new.id := old.id;
  return new;
end;
$$;
drop trigger if exists profiles_role_guard on profiles;
create trigger profiles_role_guard before update on profiles
  for each row execute function public.neon_guard_profile_role();

-- allowed_emails: the guest list is the admin console.
create policy allowed_emails_all on allowed_emails for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- PostgREST reaches these through the `authenticated` role; RLS decides the
-- rows, the grant decides whether the table is addressable at all.
grant select, update on profiles to authenticated;
grant delete on profiles to authenticated;
grant select, insert, update, delete on allowed_emails to authenticated;
grant all on profiles, allowed_emails to service_role;

-- ---------------------------------------------------------------------------
-- RPC hardening. Everything anon could call, authenticated calls now — and the
-- two SECURITY DEFINER functions that bypass RLS by construction check the
-- caller's ownership themselves.
-- ---------------------------------------------------------------------------
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
  where id = p_job and status in ('queued', 'running')
    -- SECURITY DEFINER skips RLS, so the owner check has to be here or this
    -- function is a cancel-anyone's-render button.
    and (owner_id = auth.uid() or public.is_admin())
  returning * into j;
  return j;
end;
$$;
revoke execute on function request_job_cancel(uuid) from public, anon;
grant execute on function request_job_cancel(uuid) to authenticated, service_role;

-- reorder_scenes is INVOKER rights, exactly as its own comment intended: now
-- that RLS is real, a caller can only renumber scenes they can already see.
revoke execute on function reorder_scenes(uuid, uuid[]) from anon;
grant execute on function reorder_scenes(uuid, uuid[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Realtime + RLS: DELETE events.
--
-- Realtime evaluates the SELECT policy against the WAL record before delivering
-- it. For an INSERT/UPDATE that record is the whole row and `owner_id` is right
-- there; for a DELETE it is only the replica identity — the primary key —
-- so `owner_id = auth.uid()` cannot be evaluated and the event is dropped for
-- everyone. That reads as "I deleted it and the grid still shows it until I
-- reload". REPLICA IDENTITY FULL puts the old row in the WAL so the policy can
-- run.
--
-- Deliberately NOT applied to `jobs`: a render writes progress every ~2s and
-- full replica identity doubles the WAL for each of those ticks, while job rows
-- are essentially never deleted (only legacy kind='image' ones).
-- ---------------------------------------------------------------------------
do $do$
declare t text;
begin
  foreach t in array array['assets', 'projects', 'episodes', 'collections',
                           'collection_assets', 'bible_entries', 'bible_assets',
                           'bible_revisions', 'chat_threads', 'storyboards',
                           'scenes', 'beats', 'generation_blocks', 'block_takes',
                           'take_assemblies', 'timelines', 'tracks', 'clips'] loop
    execute format('alter table public.%I replica identity full', t);
  end loop;
end $do$;

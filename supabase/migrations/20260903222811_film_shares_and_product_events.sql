-- Sharing a finished film, and the five moments that say whether any of this
-- works.
--
-- WHY THESE TWO TOGETHER. The binding constraint on this product is not margin
-- and it is not the render pipeline — at steady state the model says 240
-- subscribers and $112k ARR, and getting to $500k needs roughly 1,780 installs
-- a month. Nothing in the app currently produces an install, and nothing
-- currently measures one. A share link is the only artifact a user makes that
-- another person sees, and `product_events` is the only way to know whether
-- anybody who saw one came back. They are one feature.
--
-- ---------------------------------------------------------------------------
-- film_shares
--
-- UNLISTED OR REVOKED, and deliberately no 'public'. There is no gallery, so a
-- 'public' value would name a discoverability that does not exist and would
-- read, to whoever set it, as a promise the product does not keep. The link IS
-- the access control: `slug` is 12 characters of base64url over 9 random bytes,
-- so ~72 bits — not guessable, and not enumerable by counting up from someone
-- else's. Add 'listed' the day a gallery ships, not before.
--
-- NO ANON POLICY, which is the part worth reading twice. The obvious shape for
-- a public page is a permissive `to anon` select, and it is the wrong one: it
-- opens the table to every holder of the anon key (which ships in the browser
-- bundle) and makes "what does a viewer see" a question about RLS phrasing
-- rather than about one function's output. The `share` edge function reads
-- these rows with the service key and decides what to render, so this table
-- stays owner-only exactly like every other, and the public surface is a
-- server that returns HTML.
--
-- `asset_id` CASCADES. A share whose film has been deleted is a link that 404s
-- with a title on it — worse than a link that is gone.
create table if not exists film_shares (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  project_id uuid,
  slug text not null unique
    default translate(encode(extensions.gen_random_bytes(9), 'base64'), '+/', '-_'),
  -- The film itself. A `tl_render` output or an assembled episode cut — both
  -- are ordinary registered assets (invariant #2), and both are already public
  -- on the CDN, so the page serves the bytes that are already there rather
  -- than copying anything.
  asset_id uuid not null references assets(id) on delete cascade,
  title text not null,
  synopsis text,
  -- The card image. SET NULL rather than cascade: losing the poster should
  -- leave the film shareable, and the page falls back to the first frame.
  poster_asset_id uuid references assets(id) on delete set null,
  visibility text not null default 'unlisted'
    check (visibility in ('unlisted', 'revoked')),
  views bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists film_shares_owner_idx on film_shares (owner_id);
create index if not exists film_shares_project_idx on film_shares (project_id);

drop trigger if exists film_shares_updated on film_shares;
create trigger film_shares_updated before update on film_shares
  for each row execute procedure extensions.moddatetime(updated_at);

-- ---------------------------------------------------------------------------
-- product_events — the funnel, append-only.
--
-- FIVE MOMENTS, and they are the ones the margin model currently guesses:
-- install, key configured, first plan, first render, first export. Conversion
-- and churn are the two numbers every projection rests on and neither has ever
-- been observed here, so the beta's real job is to produce them.
--
-- NO ANALYTICS DEPENDENCY. A third-party tag would be a script on a page that
-- also holds someone's API keys, a second privacy surface to explain, and a
-- vendor to keep paying. One table the app already has a client for answers
-- the five questions being asked.
--
-- APPEND-ONLY BY POLICY: insert and select, no update, no delete. An event log
-- that can be edited is not evidence of anything.
create table if not exists product_events (
  id bigint generated always as identity primary key,
  owner_id uuid,
  -- NULLABLE, and present so the row has a parent to be owned THROUGH. The
  -- five funnel moments split: `install` and `key_configured` are about the
  -- machine and carry none, while `first_plan`, `first_render` and
  -- `first_export` all have one. Without this column an event the WORKER
  -- writes would land with `owner_id` null — the service key bypasses RLS and
  -- `auth.uid()` is null for it — and be invisible to the person it is about.
  project_id uuid,
  -- Free text rather than an enum: a funnel gains a step whenever the product
  -- does, and a check constraint here would mean a migration to measure
  -- something new — which is how measuring stops happening.
  event text not null,
  -- Deliberately small and non-identifying: a plan's model, a render's length.
  -- Nothing here should ever hold prose, a prompt or a filename.
  props jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists product_events_owner_idx on product_events (owner_id, event);
create index if not exists product_events_time_idx on product_events (created_at);
create index if not exists product_events_project_idx on product_events (project_id);

-- ---------------------------------------------------------------------------
-- The ownership machinery, applied to exactly these tables.
--
-- `neon_owned_tables()` and the parent map in 20260812190000_accounts.sql name
-- them too — that file is what `src/lib/ownership.test.ts` reads, so a table
-- added in only one of the two places fails the guard rather than shipping
-- with `using (true)`.
--
-- Both take the project chain. `product_events`' project is optional, so the
-- trigger falls through to `auth.uid()` for the two events that have none —
-- but the chain has to be THERE, or an event written with the service key
-- (the worker, a future server-side funnel step) is owned by nobody and
-- readable by nobody.
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

drop trigger if exists film_shares_set_owner on film_shares;
create trigger film_shares_set_owner before insert on film_shares
  for each row execute function public.set_row_owner('projects', 'project_id');

drop trigger if exists product_events_set_owner on product_events;
create trigger product_events_set_owner before insert on product_events
  for each row execute function public.set_row_owner('projects', 'project_id');

alter table film_shares enable row level security;
alter table product_events enable row level security;

-- A collaborator on a shared project may publish and revoke its films; that is
-- the same authority they already have over its takes.
drop policy if exists film_shares_select on film_shares;
create policy film_shares_select on film_shares for select to authenticated
  using (owner_id = auth.uid() or project_id in (select public.shared_projects('viewer')));
drop policy if exists film_shares_insert on film_shares;
create policy film_shares_insert on film_shares for insert to authenticated
  with check (owner_id = auth.uid() or project_id in (select public.shared_projects('editor')));
drop policy if exists film_shares_update on film_shares;
create policy film_shares_update on film_shares for update to authenticated
  using (owner_id = auth.uid() or project_id in (select public.shared_projects('editor')));
drop policy if exists film_shares_delete on film_shares;
create policy film_shares_delete on film_shares for delete to authenticated
  using (owner_id = auth.uid() or project_id in (select public.shared_projects('editor')));

-- Append-only, and readable by its author or an admin. The admin read is the
-- point of the table: the funnel is a question about everybody at once.
drop policy if exists product_events_insert on product_events;
create policy product_events_insert on product_events for insert to authenticated
  with check (owner_id = auth.uid());
drop policy if exists product_events_select on product_events;
create policy product_events_select on product_events for select to authenticated
  using (owner_id = auth.uid() or public.is_admin());

grant select, insert, update, delete on film_shares to authenticated;
grant select, insert on product_events to authenticated;
grant all on film_shares, product_events to service_role;
grant usage on sequence product_events_id_seq to authenticated, service_role;

-- A DELETE puts only the replica identity in the WAL, so `owner_id = auth.uid()`
-- cannot be evaluated and realtime drops the event for everyone — "I revoked
-- the link and it is still listed until I reload". `product_events` is
-- deliberately NOT published: nothing watches it live and it is the highest-
-- volume table here.
alter table film_shares replica identity full;

do $do$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public'
       and tablename = 'film_shares') then
    alter publication supabase_realtime add table film_shares;
  end if;
end $do$;

-- ---------------------------------------------------------------------------
-- One view, counted atomically.
--
-- SECURITY DEFINER because the caller is the share page's edge function acting
-- for an anonymous visitor, and because `views = views + 1` read-then-written
-- from outside would lose counts under any concurrency at all. It returns
-- nothing and takes only a slug, so the worst it can do is increment a counter
-- on a row somebody already has the link to.
-- ---------------------------------------------------------------------------
create or replace function public.bump_share_views(p_slug text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.film_shares
     set views = views + 1
   where slug = p_slug and visibility <> 'revoked';
$$;

revoke all on function public.bump_share_views(text) from public;
grant execute on function public.bump_share_views(text) to service_role;

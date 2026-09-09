-- Incognito collections: `collections.hidden` takes every asset filed in that
-- collection out of the main library, the pickers and the director's search.
--
-- The truth is membership (`collection_assets` × `collections.hidden`), but the
-- QUESTION every browse asks is "is this one asset hidden?" — and PostgREST has
-- no way to phrase `not exists (…)` against an embedded table. Answering it from
-- the client would mean fetching the hidden id set and passing it as an `in.(…)`
-- list on every query, in every caller, including the worker. So the answer is
-- denormalised onto `assets.hidden` and kept true by trigger: one indexed
-- boolean that every surface filters on, and no call site that can forget to.
--
-- This is concealment, not access control. RLS here is open to the anon key
-- (the app's single-user posture), so a hidden asset is hidden from the UI, not
-- from anyone holding the key. Don't sell it as more than that.

alter table collections add column if not exists hidden boolean not null default false;
alter table assets add column if not exists hidden boolean not null default false;
-- Partial: hidden is the small set, and every browse is the other side of it.
create index if not exists assets_hidden_idx on assets (hidden) where hidden;

create or replace function asset_is_hidden(a_id uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from collection_assets ca
      join collections c on c.id = ca.collection_id
     where ca.asset_id = a_id and c.hidden);
$$;

-- `is distinct from` so a no-op stays a no-op: these rows are in the realtime
-- publication, and rewriting them on every membership change would wake every
-- live query in the app for nothing.
create or replace function refresh_assets_hidden(ids uuid[]) returns void
language sql as $$
  update assets a set hidden = asset_is_hidden(a.id)
   where a.id = any(ids)
     and a.hidden is distinct from asset_is_hidden(a.id);
$$;

-- Filing or unfiling an asset re-answers the question for that asset only.
create or replace function collection_assets_hidden_sync() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform refresh_assets_hidden(array[old.asset_id]);
  elsif tg_op = 'UPDATE' then
    perform refresh_assets_hidden(array[old.asset_id, new.asset_id]);
  else
    perform refresh_assets_hidden(array[new.asset_id]);
  end if;
  return null;
end $$;

drop trigger if exists collection_assets_hidden on collection_assets;
create trigger collection_assets_hidden
  after insert or update or delete on collection_assets
  for each row execute function collection_assets_hidden_sync();

-- Flipping a collection's own flag re-answers it for everything filed in it.
-- Deleting a collection needs no trigger here: the memberships cascade, and
-- each cascaded row fires the trigger above.
create or replace function collections_hidden_sync() returns trigger
language plpgsql as $$
declare ids uuid[];
begin
  select array_agg(asset_id) into ids
    from collection_assets where collection_id = new.id;
  if ids is not null then perform refresh_assets_hidden(ids); end if;
  return null;
end $$;

drop trigger if exists collections_hidden on collections;
create trigger collections_hidden
  after update of hidden on collections
  for each row when (old.hidden is distinct from new.hidden)
  execute function collections_hidden_sync();

-- Backfill, so the column is true of the data and not just of what happens next.
update assets a set hidden = asset_is_hidden(a.id)
 where a.hidden is distinct from asset_is_hidden(a.id);

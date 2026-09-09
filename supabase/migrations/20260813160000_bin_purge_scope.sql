-- Emptying YOUR recycle bin must not be able to purge anyone else's media.
--
-- The bin is a soft delete, so the LISTING is already account-scoped by RLS
-- (`assets.owner_id`), and the hard delete goes DB-row-first: the client's
-- DELETE is RLS-filtered and returns only the `b2_key`s it was actually allowed
-- to remove. What was not covered is `/api/delete` itself — it took raw B2 keys
-- and trusted them, and media URLs are public, so a collaborator on a shared
-- project legitimately knows real keys belonging to the project owner.
--
-- The check cannot run against `assets` as the caller, because by the time the
-- purge happens the row is gone. It has to ask the inverse question — "is this
-- key registered to somebody ELSE right now?" — which needs to see rows RLS
-- hides. Hence SECURITY DEFINER.
--
-- Deliberately NOT the service key: the obvious implementation (query the table
-- twice, once as the service role and once as the caller, and diff) puts a
-- bypass-everything credential into a request path that does not otherwise need
-- one, and this project's local `.env` copy of that key is currently rejected
-- by the API anyway — a gate that depends on it would have failed closed and
-- broken every delete.
--
-- Everything not returned here is allowed: a key with no row is either the row
-- the caller just deleted (RLS already vetted that) or a v1 object that was
-- never registered, and `gc_sweep` collects unregistered objects regardless.
create or replace function public.keys_not_purgeable(p_keys text[])
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select a.b2_key
    from public.assets a
   where a.b2_key = any(p_keys)
     and a.owner_id is distinct from auth.uid()
     -- an editor on a shared project may clear that project's media
     and (a.project_id is null
          or a.project_id not in (select public.shared_projects('editor')));
$$;
revoke execute on function public.keys_not_purgeable(text[]) from public, anon;
grant execute on function public.keys_not_purgeable(text[]) to authenticated, service_role;

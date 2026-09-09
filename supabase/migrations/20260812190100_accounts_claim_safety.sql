-- The orphan claim must never be able to block a sign-in.
--
-- `neon_handle_new_user` runs INSIDE the auth.users insert, so anything it
-- raises aborts account creation — and the one thing it does that touches
-- twenty-nine tables and six thousand rows is `claim_orphan_data`. A lock
-- timeout, a statement timeout, one bad row: the studio owner's Google sign-in
-- fails with "Database error saving new user" and there is no way in at all,
-- because the account that would fix it is the account that cannot be created.
--
-- So the claim becomes advisory (log and carry on) and gains a manual
-- counterpart: `orphan_data_count()` tells an admin how much is sitting
-- unattached and the accounts panel offers to adopt it. Same shape as the
-- LLM fallback chain elsewhere in this codebase — the expensive optional step
-- degrades, the thing it was helping never fails because of it.

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

  if coalesce(v_role, 'member') = 'admin'
     and not exists (select 1 from public.profiles
                      where role = 'admin' and id <> new.id) then
    begin
      perform public.claim_orphan_data(new.id);
    exception when others then
      -- Recoverable from the accounts panel; a failed sign-in is not.
      raise warning 'claim_orphan_data failed for %: % — adopt from Accounts & invites',
        new.email, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

-- What an admin would adopt, per table. SECURITY DEFINER because the whole
-- point is counting rows RLS is currently hiding from everyone.
create or replace function public.orphan_data_count()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare t text; n int; res jsonb := '{}'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'orphan_data_count: admin only' using errcode = '42501';
  end if;
  foreach t in array public.neon_owned_tables() loop
    continue when t in ('rag_documents', 'rag_chunks');
    execute format('select count(*) from public.%I where owner_id is null', t) into n;
    if n > 0 then res := res || jsonb_build_object(t, n); end if;
  end loop;
  return res;
end;
$$;
revoke execute on function public.orphan_data_count() from public, anon;
grant execute on function public.orphan_data_count() to authenticated, service_role;

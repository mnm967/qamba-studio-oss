-- BYOK on the POD: a key the render box can read, for the two things a
-- keychain cannot reach.
--
-- WHY THIS EXISTS AT ALL. A BYOK key lives in this machine's OS keychain and
-- every render that uses one is driven from this machine, on `lane: 'local'`.
-- Two pipelines cannot move there: an episode's per-block `master_pass` is
-- Python (`h3_prompt.compile_block`, the whole reference-staging pass) and the
-- staged planner is `storyplan.py`. Both run on the pod, so a key held on a
-- laptop is unreachable from them — and there is no version of "the pod calls
-- the laptop" that survives a NAT.
--
-- SO IT IS OPT-IN, PER PROVIDER, AND SEPARATE FROM THE KEYCHAIN. Sharing does
-- not move the key; it makes a SECOND copy the worker can read. The default
-- stays keys-never-leave-this-machine, and revoking is one row.
--
-- ENCRYPTED, AND WRITE-ONLY FROM THE BROWSER. The value goes into
-- `supabase_vault`, which is authenticated encryption at rest with the key
-- held outside the database. Nothing readable by the anon key ever contains
-- it: the browser calls a definer-rights function that takes the value and
-- returns nothing, and the only path back out is `vault.decrypted_secrets`,
-- which is service-role only. So a stolen anon key — or a stolen session —
-- cannot read a shared key back, only overwrite or delete it.

create table if not exists public.byok_pod_keys (
  owner_id   uuid not null references auth.users(id) on delete cascade,
  provider   text not null,
  -- The vault row's id. NOT the value: this table is readable by its owner so
  -- the UI can show which providers are shared, and a value here would make
  -- that listing a disclosure.
  secret_id  uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, provider)
);

comment on table public.byok_pod_keys is
  'Which providers a user has shared with the render pod. The key itself is in supabase_vault; this row only points at it.';

alter table public.byok_pod_keys enable row level security;

-- SELECT is the "which have I shared" listing, and it is safe precisely
-- because the value is not here. There is no INSERT/UPDATE policy: writes go
-- through byok_share_key() below, so a client can never choose the secret_id
-- and point its row at somebody else's vault entry.
drop policy if exists byok_pod_keys_select_own on public.byok_pod_keys;
create policy byok_pod_keys_select_own on public.byok_pod_keys
  for select using (owner_id = auth.uid());

drop policy if exists byok_pod_keys_delete_own on public.byok_pod_keys;
create policy byok_pod_keys_delete_own on public.byok_pod_keys
  for delete using (owner_id = auth.uid());

grant select, delete on public.byok_pod_keys to authenticated;

-- ── writing one ────────────────────────────────────────────────────────────
--
-- SECURITY DEFINER because it writes to the vault, which the caller cannot
-- touch. It returns void deliberately: a function that handed back the secret
-- id would let a client correlate rows, and there is nothing a caller needs
-- from it beyond "it worked".
create or replace function public.byok_share_key(p_provider text, p_key text)
returns void
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_owner uuid := auth.uid();
  v_existing uuid;
  v_name text;
begin
  if v_owner is null then
    raise exception 'byok_share_key requires a signed-in user';
  end if;
  -- The same list `secrets.rs::allowed_hosts` enforces. A provider the worker
  -- cannot call is a secret nothing will ever read.
  if p_provider not in ('openai', 'anthropic', 'google', 'fal', 'minimax',
                        'elevenlabs', 'openrouter', 'replicate') then
    raise exception 'unknown provider %', p_provider;
  end if;
  if coalesce(btrim(p_key), '') = '' then
    raise exception 'that key is empty';
  end if;

  v_name := format('byok:%s:%s', v_owner, p_provider);
  select secret_id into v_existing
    from public.byok_pod_keys where owner_id = v_owner and provider = p_provider;

  if v_existing is not null then
    -- UPDATE the existing vault row rather than creating a second one:
    -- `vault.create_secret` uniques on name, so a re-share would raise, and
    -- orphaning the old row leaves a decryptable copy of a rotated key.
    perform vault.update_secret(v_existing, p_key, v_name, 'Qamba Studio BYOK');
    update public.byok_pod_keys
       set updated_at = now() where owner_id = v_owner and provider = p_provider;
  else
    insert into public.byok_pod_keys (owner_id, provider, secret_id)
    values (v_owner, p_provider,
            vault.create_secret(p_key, v_name, 'Qamba Studio BYOK'));
  end if;
end;
$$;

revoke all on function public.byok_share_key(text, text) from public;
grant execute on function public.byok_share_key(text, text) to authenticated;

-- ── revoking one ───────────────────────────────────────────────────────────
--
-- The vault row goes WITH the pointer. A delete policy alone would leave the
-- encrypted value behind forever, which is the opposite of what pressing
-- "stop sharing" means.
create or replace function public.byok_unshare_key(p_provider text)
returns void
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_owner uuid := auth.uid();
  v_secret uuid;
begin
  if v_owner is null then
    raise exception 'byok_unshare_key requires a signed-in user';
  end if;
  delete from public.byok_pod_keys
   where owner_id = v_owner and provider = p_provider
   returning secret_id into v_secret;
  if v_secret is not null then
    delete from vault.secrets where id = v_secret;
  end if;
end;
$$;

revoke all on function public.byok_unshare_key(text) from public;
grant execute on function public.byok_unshare_key(text) to authenticated;

-- ── reading one, from the worker ───────────────────────────────────────────
--
-- SERVICE ROLE ONLY. `vault.decrypted_secrets` is already restricted, and this
-- adds the join the worker needs without giving anything else a path to it.
-- Note there is no `to authenticated` grant: a signed-in user reading their
-- OWN key back would be a perfectly reasonable-sounding feature and is exactly
-- the hole this table is shaped to avoid — the browser has the keychain.
create or replace function public.byok_key_for(p_owner uuid, p_provider text)
returns text
language sql
security definer
set search_path = public, vault, pg_temp
as $$
  select s.decrypted_secret
    from public.byok_pod_keys k
    join vault.decrypted_secrets s on s.id = k.secret_id
   where k.owner_id = p_owner and k.provider = p_provider;
$$;

revoke all on function public.byok_key_for(uuid, text) from public;
revoke all on function public.byok_key_for(uuid, text) from authenticated;
revoke all on function public.byok_key_for(uuid, text) from anon;
grant execute on function public.byok_key_for(uuid, text) to service_role;

-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on new public functions to
-- `anon` as well as `authenticated`, and `revoke ... from public` does not
-- touch a grant made directly to a role — so the two writers above came out
-- anon-executable. Both already refuse an anonymous caller (`auth.uid()` is
-- null and they raise), so this is defence in depth rather than a fix; a grant
-- that does not match the intent is one somebody later reads AS the intent.
revoke all on function public.byok_share_key(text, text) from anon;
revoke all on function public.byok_unshare_key(text) from anon;
revoke all on table public.byok_pod_keys from anon;

-- Fish Audio joins the providers a key may be shared with.
--
-- WHY A MIGRATION FOR ONE STRING. `byok_share_key`'s check is one of THREE
-- places that hold this list — `secrets.rs::allowed_hosts` decides where a key
-- may be SENT, this decides what may be SHARED with the pod, and
-- `worker/byok.PROVIDERS` decides what may be SPENT. `test_byok.py` parses all
-- three and fails on a disagreement, because every one of them is silent: a
-- provider Rust allows and SQL refuses is a share button that errors, and one
-- SQL allows and the worker does not is an encrypted key nothing will ever
-- read.
--
-- Fish is here because VOICE is the first pipeline the desktop can run end to
-- end on its own: `handlers/tts` is now a job kind the local runner claims,
-- and `dialogue_synth` measures every line at PLAN time. A user whose own key
-- drives that on their laptop should be able to share it with the pod for the
-- episodes they render there, exactly as they can for ElevenLabs.
--
-- The body below is the 20260829120000 one VERBATIM with one string added.
-- `create or replace` cannot patch a list, and retyping the function is how a
-- search_path or a vault description quietly changes underneath it.

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
                        'elevenlabs', 'fish', 'openrouter', 'replicate') then
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

-- Supabase's default privileges grant EXECUTE on a new public function to
-- `anon`, and `revoke ... from public` does NOT touch a grant made directly to
-- a role — so a replaced function needs this again. Defence in depth: the
-- `auth.uid()` guard already makes an anonymous call inert.
revoke all on function public.byok_share_key(text, text) from anon;

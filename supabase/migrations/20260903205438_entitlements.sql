-- Entitlements: which PLAN an account is on, as a fact the database owns.
--
-- WHY THIS IS A SEPARATE COLUMN FROM `role`, and not a widened check
-- constraint on it. `role` answers "may this account spend the STUDIO's
-- money" — the pod, the studio's provider keys, the director routes — and
-- nineteen surfaces read it for exactly that. `plan` answers "has this account
-- paid", which is a different question with a different lifecycle: it expires,
-- it is set by a payment processor rather than by an invitation, and a member
-- on Pro is still not an admin. Folding the two into one enum would mean every
-- `role = 'admin'` check silently became a billing check.
--
-- WHY IT SHIPS BEFORE ANYTHING IS SOLD. A gate that arrives in build fifty and
-- is absent from build one makes the diff between them a patching roadmap:
-- every beta build is a permanent, public, versioned artifact at an immutable
-- key, so "add the checks later" means shipping a fully unlocked copy that
-- never stops working. The columns and the guard exist from the first public
-- build; what fills them can come later.
--
-- THE CLIENT NEVER READS THIS DIRECTLY TO DECIDE ANYTHING. `entitlement_claims`
-- below is what the signer (the `entitlement` edge function) calls, and the
-- desktop trusts a SIGNED token rather than a row it could patch. This table is
-- the source of truth; the token is how the truth reaches a machine that may be
-- offline.

-- ---------------------------------------------------------------------------
-- profiles.plan
-- ---------------------------------------------------------------------------
alter table profiles
  add column if not exists plan text not null default 'free',
  -- NULL means open-ended: an auto-renewing subscription that stops when the
  -- processor says so, not on a date known in advance. A beta grant and a
  -- cancelled subscription both carry a real date.
  add column if not exists plan_until timestamptz,
  -- Where the plan came from: 'beta' | 'grant' | 'stripe' | 'paddle' | ...
  -- Kept because the answer to "why is this account on Pro" is otherwise a
  -- guess, and a beta grant has to be distinguishable from a paid one at the
  -- moment the beta ends.
  add column if not exists plan_source text;

-- Stated separately so re-running the migration is safe, and so adding a tier
-- later is a two-line change rather than a column rewrite.
alter table profiles drop constraint if exists profiles_plan_check;
alter table profiles add constraint profiles_plan_check
  check (plan in ('free', 'pro', 'studio'));

-- ---------------------------------------------------------------------------
-- app_config — one row, the settings a release should not have to redeploy for.
--
-- `beta_pro_until` is what STARTS and ENDS the open beta: while it is in the
-- future every new account is granted Pro until that instant. NULL (the value
-- it ships with) grants nothing, so applying this migration changes no
-- account's plan — the beta begins the day somebody sets a date.
-- ---------------------------------------------------------------------------
create table if not exists app_config (
  -- `check (id)` plus a primary key is the singleton idiom: exactly one row can
  -- exist, so there is never a question of which config is live.
  id boolean primary key default true check (id),
  beta_pro_until timestamptz,
  updated_at timestamptz not null default now()
);
insert into app_config (id) values (true) on conflict (id) do nothing;

drop trigger if exists app_config_updated on app_config;
create trigger app_config_updated before update on app_config
  for each row execute procedure extensions.moddatetime(updated_at);

alter table app_config enable row level security;
-- Readable by anyone signed in (the app says "the beta runs until X"), written
-- by admins only. Not a secret; it is a date on a marketing page.
drop policy if exists app_config_select on app_config;
create policy app_config_select on app_config for select to authenticated using (true);
drop policy if exists app_config_write on app_config;
create policy app_config_write on app_config for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, update on app_config to authenticated;
grant all on app_config to service_role;

-- ---------------------------------------------------------------------------
-- The guard. `profiles` is a row its owner may edit — they set their own
-- display name — and RLS is row-level, so the update policy alone lets any
-- member write `plan = 'studio'` onto themselves. This is the same hole
-- `role` had, and the same answer.
--
-- KEEPS ITS NAME. Nothing outside SQL references it and renaming a live
-- function is a migration that has to ship in lockstep with whatever names it;
-- what it guards has widened, so the comment has.
-- ---------------------------------------------------------------------------
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
  -- The billing columns. An admin may set them by hand (that is how a grant is
  -- issued and how the studio owner fixes a botched webhook); the service key
  -- bypasses this trigger entirely, which is how a payment processor's webhook
  -- will write them.
  if (new.plan        is distinct from old.plan
   or new.plan_until  is distinct from old.plan_until
   or new.plan_source is distinct from old.plan_source)
     and not public.is_admin() then
    raise exception 'only an admin can change an account plan'
      using errcode = '42501';
  end if;
  new.id := old.id;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- What plan is this account on RIGHT NOW.
--
-- One function so the signer, any future policy and the accounts panel cannot
-- disagree about expiry. Three rules:
--
--   * an ADMIN is always Studio. The studio owner should not have to grant
--     themselves a licence to their own product, and a capped export on the
--     account that renders every episode is a support ticket with no fix.
--   * a plan whose `plan_until` has passed is Free. Expiry is evaluated here,
--     once, rather than by each reader.
--   * `until` comes back so the signer can decide whether the token it is
--     about to issue is the LAST one (see `final` in the edge function): a
--     token that expires because the subscription ended must not then be
--     extended by the offline grace window.
--
-- SECURITY DEFINER because it reads `profiles` and the signer calls it for a
-- user other than itself; `p_user` defaults to the caller so an ordinary
-- session can ask about its own plan without a service key.
-- ---------------------------------------------------------------------------
create or replace function public.entitlement_claims(p_user uuid default auth.uid())
returns table (plan text, until timestamptz, source text)
language sql
stable
security definer
set search_path = public
as $$
  select
    case
      when p.role = 'admin' then 'studio'
      when p.plan_until is not null and p.plan_until <= now() then 'free'
      else coalesce(p.plan, 'free')
    end as plan,
    case when p.role = 'admin' then null else p.plan_until end as until,
    case when p.role = 'admin' then 'admin' else p.plan_source end as source
  from public.profiles p
  where p.id = p_user;
$$;

revoke all on function public.entitlement_claims(uuid) from public;
grant execute on function public.entitlement_claims(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The beta grant, at signup.
--
-- REPLACED WHOLE because `create or replace` is the only way to change a live
-- function's body, so everything the previous version did is reproduced here —
-- the role lookup from `allowed_emails`, the display-name/avatar coalesce on
-- conflict, and the first-admin orphan claim. The only addition is the two
-- plan columns.
--
-- `is_admin()` is deliberately NOT consulted here: this runs inside
-- `auth.users`' own insert trigger, where `auth.uid()` is not the new user, and
-- an admin's plan is answered by `entitlement_claims` at read time anyway.
-- ---------------------------------------------------------------------------
create or replace function public.neon_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_beta timestamptz;
begin
  select a.role into v_role
    from public.allowed_emails a where a.email = lower(new.email);

  -- NULL while the beta is not running, which is the state this ships in.
  select c.beta_pro_until into v_beta
    from public.app_config c where c.id and c.beta_pro_until > now();

  insert into public.profiles (
    id, email, display_name, avatar_url, role, plan, plan_until, plan_source)
  values (
    new.id,
    lower(new.email),
    nullif(coalesce(new.raw_user_meta_data ->> 'full_name',
                    new.raw_user_meta_data ->> 'name'), ''),
    nullif(new.raw_user_meta_data ->> 'avatar_url', ''),
    coalesce(v_role, 'member'),
    case when v_beta is not null then 'pro' else 'free' end,
    v_beta,
    case when v_beta is not null then 'beta' else null end
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

-- ---------------------------------------------------------------------------
-- Grant the beta to accounts that ALREADY exist.
--
-- The trigger above only fires for new sign-ups, and the people most likely to
-- be in the beta are the ones already here. Idempotent, and it never touches
-- an account that is paying: a `plan_source` of anything but 'beta' or NULL is
-- left exactly as it is.
-- ---------------------------------------------------------------------------
create or replace function public.grant_beta_to_existing()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_beta timestamptz;
  v_n integer;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  select c.beta_pro_until into v_beta
    from public.app_config c where c.id and c.beta_pro_until > now();
  if v_beta is null then
    return 0;
  end if;
  update public.profiles
     set plan = 'pro', plan_until = v_beta, plan_source = 'beta'
   where coalesce(plan_source, 'beta') = 'beta'
     and (plan is distinct from 'pro' or plan_until is distinct from v_beta);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.grant_beta_to_existing() from public;
grant execute on function public.grant_beta_to_existing() to authenticated;

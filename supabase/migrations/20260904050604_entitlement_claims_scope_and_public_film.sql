-- Two things this closes, and one it writes down for the first time.
--
-- 1. `entitlement_claims(p_user uuid DEFAULT auth.uid())` WAS READABLE BY
--    ANYONE. It is SECURITY DEFINER, Supabase grants EXECUTE on a new public
--    function to `anon` by default, and the anon key ships in the browser
--    bundle — so an unauthenticated caller who knew a uuid could ask for that
--    account's plan, expiry and source. Measured against the live database
--    before this migration: `{"plan":"studio","until":null,"source":"admin"}`
--    for an account whose `profiles` row RLS correctly refused to return.
--    Knowing WHICH accounts are admins is exactly the enumeration an open
--    beta should not hand out.
--
--    The parameter had no caller. `entitlementSync.ts` and the entitlement
--    edge function both invoke it bare, with the signed-in user's own token,
--    so removing it costs nothing and makes the disclosure unexpressible
--    rather than merely guarded. An admin console that ever needs to read
--    somebody else's plan should get its own is_admin()-guarded function.
--
-- 2. THE GRANTS DID NOT MATCH THE INTENT, on every function here. That is the
--    trap this repo already documents once: `revoke ... from public` does not
--    touch a grant made directly to a role, and Supabase's default privileges
--    hand EXECUTE to `anon` and `authenticated` on every new public function.
--    `grant_beta_to_existing()` was anon-executable — its own is_admin() body
--    refused the call, so nothing escaped, but a grant nobody meant is one
--    somebody later reads AS the intent.
--
-- 3. `public_film()` existed in the live database and in NO migration file —
--    applied by hand while the share page was being built. A fresh database
--    built from this directory would have had `/f/:slug` 500 on every request
--    with nothing in the repo to explain it. Recorded here verbatim.

-- --------------------------------------------------------------- claims ---
drop function if exists public.entitlement_claims(uuid);

create or replace function public.entitlement_claims()
returns table (plan text, until timestamptz, source text)
language sql stable security definer set search_path = public
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
  where p.id = auth.uid();
$$;

revoke all on function public.entitlement_claims() from public, anon;
grant execute on function public.entitlement_claims() to authenticated, service_role;

-- ------------------------------------------------------------ beta grant ---
revoke all on function public.grant_beta_to_existing() from public, anon;
grant execute on function public.grant_beta_to_existing() to authenticated, service_role;

-- ------------------------------------------------------- the share page ---
-- ANON IS DELIBERATE ON BOTH OF THESE, and it is a change of mind the
-- film_shares migration predates: that one was written for a Supabase edge
-- function holding the service key. Supabase rewrites a text/html response to
-- text/plain and replaces the CSP with `sandbox`, so the page moved to a
-- Vercel function — which has no caller session and uses the anon key. These
-- two ARE the public surface, and nothing else about film_shares is: the table
-- stays owner-only, and this function is the whole read.
create or replace function public.public_film(p_slug text)
returns table (title text, synopsis text, video_key text, poster_key text,
               width integer, height integer, duration_ms integer)
language sql stable security definer set search_path = public
as $$
  select s.title, s.synopsis, a.b2_key, p.b2_key, a.width, a.height, a.duration_ms
    from public.film_shares s
    join public.assets a on a.id = s.asset_id
    left join public.assets p on p.id = s.poster_asset_id
   where s.slug = p_slug
     and s.visibility <> 'revoked'
     and a.deleted_at is null;
$$;

revoke all on function public.public_film(text) from public;
grant execute on function public.public_film(text) to anon, authenticated, service_role;

revoke all on function public.bump_share_views(text) from public;
grant execute on function public.bump_share_views(text) to anon, authenticated, service_role;

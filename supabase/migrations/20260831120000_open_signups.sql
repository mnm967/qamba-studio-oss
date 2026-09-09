-- OPEN SIGN-UPS. The invite gate's premise is retired in the same release that
-- makes every studio-billed surface admin-only.
--
-- `neon_gate_signup` existed because "the studio has no user accounts" gave way
-- to "every account here can spend the studio's money": one pod at $3.36/hr and
-- one set of hosted provider keys, so the guest list WAS the spending control.
-- The desktop app ships as its own product now — a user brings their own GPU
-- through the local engine and their own API keys through the keychain — and
-- the studio's own cloud (pod power, the director/hosted routes) is gated on
-- `profiles.role = 'admin'` instead. Gating the door as well would refuse
-- everyone the release exists for.
--
-- WHAT IS DELIBERATELY NOT TOUCHED:
--   * `allowed_emails` STAYS. It stopped being a gate and is still the
--     role-seeding path: `neon_handle_new_user` reads it for a role and the
--     accounts panel writes it, so an address added there lands as an admin on
--     first sign-in instead of needing promotion afterwards.
--   * `neon_handle_new_user` STAYS as written. It already defaults to
--     `coalesce(v_role, 'member')`, so an uninvited sign-up is a member with no
--     change here, and `claim_orphan_data` already fires only for an admin who
--     is the FIRST admin (and advisorily, since 20260812190100) — so a stranger
--     signing up can never adopt the studio's unowned rows.
--   * Every RLS policy. Sign-in still gates the app; what changed is who may
--     obtain a sign-in, not what one is worth.

drop trigger if exists neon_gate_signup on auth.users;
drop function if exists public.neon_gate_signup();

-- Sharing needs the two sides of a share to be able to NAME each other.
--
-- `profiles_select` is `id = auth.uid() or is_admin()`, which is right as a
-- default and useless here: the owner's collaborator list would render a column
-- of uuids, and a shared project would say it came from nobody. Both are the
-- same missing fact — "this specific account is in a share with me".
--
-- A separate permissive policy rather than a rewrite of `profiles_select`, so
-- the base rule stays legible and this one states exactly what it adds. RLS
-- ORs permissive policies together.
create policy profiles_select_shared on profiles for select to authenticated
  using (
    -- accounts I have shared one of MY projects with
    exists (select 1 from project_shares s
              join projects p on p.id = s.project_id
             where s.user_id = profiles.id and p.owner_id = auth.uid())
    -- …and the owner of any project shared with ME
    or exists (select 1 from projects p
                 join project_shares s on s.project_id = p.id
                where p.owner_id = profiles.id and s.user_id = auth.uid())
  );

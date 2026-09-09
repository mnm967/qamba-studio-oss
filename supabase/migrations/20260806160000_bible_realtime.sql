-- A finished reference sheet writes `assets` (published), links it in
-- `bible_assets` (not published) and flips its `jobs` row (published). Every
-- surface that watches the bible — the wizard's cast & world step, the Bible
-- page — subscribes to `bible_entries` / `bible_assets` through useLiveQuery,
-- and those subscriptions were inert: the tables were never in the publication.
-- The card kept saying "generating sheet" long after the image had landed.
do $$
declare t text;
begin
  foreach t in array array['bible_entries', 'bible_assets'] loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

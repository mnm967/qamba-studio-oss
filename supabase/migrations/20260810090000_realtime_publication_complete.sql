-- One unpublished table kills the WHOLE channel, silently.
--
-- Measured against this project, not inferred: a channel binding
-- postgres_changes for `jobs` alone receives events; the same channel with
-- `jobs` + `projects` (not in the publication) reports SUBSCRIBED, is handed
-- server-assigned binding ids for both, and then receives NOTHING — for either
-- table, forever. Realtime builds one `realtime.subscription` set per channel
-- join, and a table that isn't in the publication takes the set down with it.
--
-- `useLiveQuery` puts every table on ONE shared channel (deliberately — see the
-- realtime gotcha in CLAUDE.md), and `projects` is subscribed by the shell, the
-- top bar, the context panel, the composer and four routes. So the very first
-- screen poisoned the channel and every live surface in the app degraded to
-- fetch-on-mount: the queue popover, the director transcript, the storyboard,
-- the bible, the takes strip. That is the "nothing updates until I refresh"
-- report, and it was never about any of those features.
--
-- Keep `REALTIME_TABLES` in src/hooks/useLiveQuery.ts identical to the
-- publication: the client now refuses to bind a table that isn't on that list,
-- so a future omission costs one console error instead of all of realtime.
do $$
declare t text;
begin
  foreach t in array array[
    -- subscribed today, and each one alone was enough to kill the channel
    'projects',          -- the shell, TopBar, ContextPanel, GenComposer, 4 routes
    'beats',             -- StoryboardView, SceneEditorModal, WizardModal
    'bible_revisions',   -- BiblePage draft list
    'cost_ledger',       -- CostsView
    -- the timeline's own state: clips/tracks/timelines were never published,
    -- so the editor could only ever be load-once + local mutation. Choosing a
    -- take or applying an effect in another surface reached the timeline only
    -- after a reload.
    'clips',
    'tracks',
    'timelines'
  ] loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

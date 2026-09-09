-- Storyboard versions.
--
-- `plan_storyboard` has always INSERTED a storyboards row rather than replacing
-- one, and every surface reads `storyboardsForEpisode(ep)[0]` — newest first.
-- So a re-plan silently retired the previous plan: its scenes, beats and
-- generation_blocks were never deleted, they simply stopped being reachable
-- from anywhere in the UI. Measured before this migration: 4 episodes carried
-- more than one board, AFTERLIGHT E3 with 20 scenes and 31 blocks split across
-- two of them.
--
-- Non-destructive was the right instinct; unreachable was the bug. Numbering
-- them is what turns an accident into a feature — re-drafting becomes something
-- you can undo, which is the whole reason the draft-session work exists on the
-- bible side.
--
-- Ordering stays keyed on `version` with created_at as the tiebreak, so a row
-- written by an older build (version 1, like every backfilled row) still sorts
-- sensibly against its siblings.

alter table storyboards
  add column if not exists version int not null default 1;

-- Backfill: number each episode's existing boards oldest-to-newest, so v1 is
-- the first plan that was ever made rather than whichever row default'd there.
with ranked as (
  select id, row_number() over (partition by episode_id order by created_at) as n
    from storyboards
)
update storyboards s set version = ranked.n
  from ranked where ranked.id = s.id and ranked.n <> s.version;

create unique index if not exists storyboards_episode_version_idx
  on storyboards (episode_id, version);

-- The read path is (episode_id, version desc); the old created_at index stays
-- for anything still ordering that way.
create index if not exists storyboards_episode_version_desc_idx
  on storyboards (episode_id, version desc);

comment on column storyboards.version is
  'Monotonic per episode. A re-plan inserts version = max+1; nothing is deleted, '
  'and every earlier plan stays selectable with its own scenes, beats and blocks.';

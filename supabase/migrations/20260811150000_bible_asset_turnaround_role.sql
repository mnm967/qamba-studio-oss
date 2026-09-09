-- Character turnaround-grid slot.
--
-- The turnaround is ONE image carrying six views of the same person (2x3
-- grid: front/back/profile/three-quarter full-bodies + two face close-ups),
-- rendered together so the views agree by construction. It stages as the
-- second identity reference in place of full_body (worker/handlers/blocks.py
-- picks), carrying four more angles of identity signal at the same slot cost.
alter table bible_assets drop constraint if exists bible_assets_role_check;
alter table bible_assets add constraint bible_assets_role_check
  check (role in ('ref',
                  -- character
                  'face','full_body','side','outfit','turnaround',
                  -- location (master doubles as the character sheet's
                  -- catch-all, so it stays in both worlds)
                  'master','alt_angle','detail','atmosphere'));

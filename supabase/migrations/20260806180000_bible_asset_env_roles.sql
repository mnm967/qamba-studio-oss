-- Location sheets get location slots.
--
-- `bible_assets.role` shipped with one vocabulary — face / full_body / side /
-- outfit / master — which is a character turnaround with "master" bolted on
-- the end. An environment entry therefore had exactly one legal slot that
-- meant anything, and the entry modal offered a place the choice of being
-- photographed head-and-shoulders. A location's sheet is other angles onto
-- itself: the establishing read, the reverse, the material detail, the mood
-- plate.
--
-- Character roles stay exactly as they were; this only widens the vocabulary.
alter table bible_assets drop constraint if exists bible_assets_role_check;
alter table bible_assets add constraint bible_assets_role_check
  check (role in ('ref',
                  -- character
                  'face','full_body','side','outfit',
                  -- location (master doubles as the character sheet's
                  -- catch-all, so it stays in both worlds)
                  'master','alt_angle','detail','atmosphere'));

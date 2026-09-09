-- Location COVERAGE slot: a whole contact sheet in one bible role.
--
-- This is the character `turnaround`'s twin, and it exists because the two
-- kinds were asymmetric in a way nothing said out loud. `orbit_sheet` renders
-- ONE take and produces both the individual views AND the stitched contact
-- sheet — and the handler saved that sheet only for a character, into
-- `turnaround`, while a location's was fetched, never registered, and deleted
-- with the temp files. So a location came out of a coverage take as eight
-- loose plates and the grid the take had already drawn was thrown away.
--
-- What the slot buys is what `turnaround` buys one kind over: `ref_plan_for`
-- stages exactly ONE picture of the environment in a video block (the master),
-- and `<Picture N>` is positional, so a sheet carrying every placement costs
-- the same slot as one plate and hands the model eight vantages instead of the
-- single frontal view it otherwise reproduces.
--
-- Deliberately NOT `turnaround` reused: a turnaround is a figure rotating in
-- front of a fixed camera and coverage is a camera moving around a fixed
-- space. They are different shapes with different prompts (h3_sheet's
-- `plan_character` vs `plan_location`), and one name for both would make
-- "which sheet is this" unanswerable from the row.
alter table bible_assets drop constraint if exists bible_assets_role_check;
alter table bible_assets add constraint bible_assets_role_check
  check (role in ('ref',
                  -- character
                  'face','full_body','side','outfit','turnaround',
                  -- location (master doubles as the character sheet's
                  -- catch-all, so it stays in both worlds)
                  'master','alt_angle','detail','atmosphere',
                  -- the location's contact sheet, produced only by an
                  -- `orbit_sheet` take — there is no single-image composer
                  -- for it, which is exactly why the take exists
                  'coverage'));

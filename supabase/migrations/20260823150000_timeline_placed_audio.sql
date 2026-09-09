-- THE MASTER TRACK CAME BACK TOO, and for the same reason the blocks did.
--
-- `syncMasterTrack` lays the storyboard's `audio_asset_id` on A1 and decides
-- whether it has already done so by looking for a clip with that asset — so
-- deleting the clip made the answer "no" and the next sync put it straight
-- back. Same bug as `excluded_block_ids`, one slot over, and it is worse on a
-- locked music video: the same pass re-asserts the mute on V1, so a cut whose
-- master track the editor removed came back silent AND re-scored.
--
-- Recorded as a PLACEMENT rather than as a deletion, which is the difference
-- from the block list: sync keeps maintaining a block clip (it repoints it at
-- every new take), so there it has to know the clip is gone on purpose. It
-- never touches this one again after inserting it, so "have I placed this?"
-- is the whole question — and answering it from a record instead of from the
-- clip covers the deleted case, the moved-to-another-lane case and a track
-- REPLACED by a new render (a different asset id, so it is placed) at once.
alter table timelines
  add column if not exists placed_audio_asset_ids uuid[] not null default '{}';

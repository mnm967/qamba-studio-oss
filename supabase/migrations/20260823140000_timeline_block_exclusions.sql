-- A BLOCK CLIP THE EDITOR REMOVED HAS TO STAY REMOVED.
--
-- `syncBlocksToTimeline` lays every block carrying a kept take onto the base
-- video lane and re-inserts any block that has no clip. That is right for a
-- block that has just rendered and wrong for one the user deleted — and the
-- two were indistinguishable, because a delete left no trace anywhere. So a
-- deleted block came back on the next sync, which is not a rare event: the
-- next take to land, the next re-render, or simply the next time the editor
-- mounted (its sync guard is a React ref, so a reload re-runs the sync from
-- scratch). Nothing errored; the block just reappeared minutes later.
--
-- Scoped to the TIMELINE rather than to the block: a cut is a selection of
-- the episode's blocks, and one left out of this cut is not left out of the
-- next timeline someone builds from the same storyboard.
--
-- No foreign key is possible on an array element, so a deleted block can
-- leave a stale uuid behind. Harmless: the list is only ever consulted for
-- blocks the sync has already found in `generation_blocks`.
alter table timelines
  add column if not exists excluded_block_ids uuid[] not null default '{}';

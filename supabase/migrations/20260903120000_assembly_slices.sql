-- Take assemblies stopped being a TILING.
--
-- `segments` is still `[{take_id, in_ms, out_ms, note?}]` and every row ever
-- written still reads correctly — a gapless tiling laid end to end in order IS
-- the sequence of source windows it already was — so there is nothing to
-- migrate. What changed is the CONTRACT, and the 20260809140000 migration
-- states the old one in a comment that is now wrong in the two ways that
-- matter: the windows are SOURCE timestamps inside their take rather than
-- positions in the block, and they need not be contiguous, ordered by time, or
-- cover the block at all.
--
-- Enforced in code, as before, by one validator on each side
-- (src/lib/assembly.ts `isValid`, worker/assembly.py `validate`).
comment on column take_assemblies.segments is
  'Ordered list of slices: [{take_id, in_ms, out_ms, note?}], where in_ms/out_ms '
  'are SOURCE timestamps inside that take and the position in the list is where '
  'it plays — pieces are packed end to end, so cut time is derived and never '
  'stored. Each slice must run forwards for at least 250ms. Not a tiling: a '
  'moment may be used twice, in any order, or left out.';

comment on column take_assemblies.duration_ms is
  'The CUT''s own length: the sum of the slices, not the block''s planned window. '
  'The browser computes it and the renderer re-adds the slices and refuses the '
  'job if the two disagree. A cut that does not match its block''s window is '
  'committed as a block of its own (jobs.payload.as_new_block) — a take that is '
  'quietly the wrong length for its slot is not an outcome the commit allows.';

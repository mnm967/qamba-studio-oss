-- A take whose PICTURE is unchanged: 'audio'.
--
-- `v2a_gen` (MMAudio) watches a take's frames, writes a new soundtrack for
-- them, and muxes it on with `-c:v copy` — so the result is the same shot with
-- different sound. It is a TAKE rather than an edit-in-place for the reason
-- every derived take here is one: the old sound is not destroyed, the review
-- path already applies, and activating it repoints the lane through machinery
-- that exists. It gets its own `kind` rather than borrowing 'edit' because
-- 'edit' means a prompt-based re-render of the PICTURE, which is the opposite
-- claim — and `kind` is what the takes strip labels a row with.
--
-- Without this the constraint rejects the insert, and it does so at the END of
-- a render that has already spent its GPU time. Same class of gap as
-- `jobs.preview_key`: a feature complete on both sides and dead in the middle.
alter table block_takes drop constraint if exists block_takes_kind_check;
alter table block_takes add constraint block_takes_kind_check
  check (kind in ('master',    -- the block's own render
                  'patch',     -- one segment re-rendered (patch_flf)
                  'spliced',   -- cut from several takes (assemble_take)
                  'edit',      -- a prompt-based re-render (video_edit)
                  'audio'));   -- re-scored; the frames are bit-identical

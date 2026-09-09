-- Live sampler previews: the B2 key of the newest in-progress frame for a
-- running job, written by the worker every few seconds while ComfyUI samples.
--
-- A column rather than a corner of `timing` or `payload` because every live
-- surface reads it off the realtime `jobs` feed it already subscribes to, and
-- because it is genuinely a property of the job, not of the request.
--
-- The object it names is deliberately NOT in `assets`. Invariant #2 is about
-- the media registry — a preview is a progress indicator that happens to be a
-- picture, it is overwritten in place for the life of the job, and it is worth
-- nothing once the real output exists. Staying unregistered is what lets
-- gc_sweep collect it on its own schedule instead of needing a delete path.
alter table jobs
  add column if not exists preview_key text;

-- Timeline audio: solo, lane volume automation, and detached block audio.
--
-- A generated block arrives as ONE mp4 with its audio baked in, so until now
-- the only volume control over a block's dialogue was the whole video lane's
-- mute. Detaching puts that audio on an audio lane as its own clip — same
-- asset, same window — where the lane fader, the automation curve and the
-- clip's own gain all reach it.
--
-- Two flags, deliberately independent:
--   clips.audio_detached  the video clip's OWN audio is off (its audio now
--                         lives on an audio lane; playing both is a comb
--                         filter, not a louder mix).
--   clips.linked_clip_id  the two halves move and trim together. Unlinking
--                         must NOT re-enable the video's audio — that would
--                         double it — which is why this is not one column.
--
-- The link is written on BOTH rows, so either half can find the other without
-- a scan. `on delete set null` covers deleting one half by hand.

alter table clips add column if not exists linked_clip_id uuid
  references clips(id) on delete set null;
alter table clips add column if not exists audio_detached boolean not null default false;
create index if not exists clips_linked_idx on clips (linked_clip_id) where linked_clip_id is not null;

-- Solo is per track and reads across the whole timeline: any solo anywhere
-- silences every track that is not soloed, video lanes included (a video
-- clip's baked audio is in the same mix as the audio lanes).
alter table tracks add column if not exists solo boolean not null default false;

-- Volume automation: [{t_ms, gain_db}, ...] in timeline time, piecewise-linear
-- between points, flat outside the first/last. It REPLACES `gain_db` when it
-- has any points (one fader value and a curve both claiming the same lane is
-- a contradiction the mix would have to resolve at random). Read by the
-- preview player (src/lib/mix.ts) and the renderer (worker/mix.py) from the
-- same shape.
alter table tracks add column if not exists automation jsonb not null default '[]';

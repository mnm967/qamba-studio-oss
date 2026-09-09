-- ElevenLabs joins the cloning providers, and it is the one that can carry a
-- whole episode.
--
-- What it hands back from `/v1/voices/add` is an ordinary ElevenLabs
-- `voice_id` — the SAME kind of value as `bible_entries.doc.el_voice_id`. So a
-- clone made here needs no synthesis path of its own (`dialogue_synth._synth`
-- already speaks one) and, unlike either Fish provider, it can be cast onto a
-- character so every dialogue block in the episode speaks in it. The Fish
-- clones can only ever be one-off lines in the studio panel, because
-- `dialogue_synth` is ElevenLabs-only.
--
-- A check constraint is the whole change. It is also exactly the kind of thing
-- that fails at the last moment if forgotten: the insert comes from the
-- browser, so a missing value here is a PostgREST 400 on the one click that
-- matters, long after the picker has offered the option.
alter table voice_clones drop constraint if exists voice_clones_provider_check;
alter table voice_clones add constraint voice_clones_provider_check
  check (provider in ('fish', 'fish-local', 'elevenlabs'));

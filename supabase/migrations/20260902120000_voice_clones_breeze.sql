-- Breeze joins the cloning providers, which it has implemented all along.
--
-- `worker/voice_clone.py` handles `"breeze"` end to end — `providers()` reports
-- it, `register()` returns no id (zero-shot: the sample and its transcript ARE
-- the voice), and `_breeze_clone` synthesises from them — and the browser could
-- never write the row, because this check has named three providers since
-- ElevenLabs joined. A `provider: 'breeze'` insert is a PostgREST 400 on the
-- one click that matters, which is the failure the previous migration's own
-- note predicted and then reproduced.
--
-- 'voxtral' is deliberately still absent: `voice_clone.py` has no branch for
-- it (its 20 voices are fixed embeddings, so there is nothing to clone), and a
-- value the worker cannot serve is an option the picker would have to hide
-- again.
alter table voice_clones drop constraint if exists voice_clones_provider_check;
alter table voice_clones add constraint voice_clones_provider_check
  check (provider in ('fish', 'fish-local', 'elevenlabs', 'breeze'));

-- The one-shot wizard's opening conversation is a real agent turn now, and the
-- facts it establishes have to live somewhere both writers can reach: the
-- hosted SSE endpoint (service key) and the pod worker running the local model
-- (note_brief in director_tools). The thread row is that place — the wizard
-- subscribes to chat_threads already, so the brief panel updates over realtime
-- for free, whichever backend produced it.
alter table chat_threads add column if not exists brief jsonb not null default '{}'::jsonb;

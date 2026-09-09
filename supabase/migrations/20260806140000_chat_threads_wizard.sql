-- A one-shot session is more than its transcript: which step it reached, the
-- plan job it is waiting on, the length/experts/models chosen along the way.
-- All of that lived in React state, so closing the modal — or reloading while
-- cast & world generated — threw the draft away even though the brief and the
-- job were already durable. The wizard thread is the session, so its state
-- belongs on the same row.
alter table chat_threads add column if not exists wizard jsonb not null default '{}'::jsonb;

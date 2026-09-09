-- The director dock now lists threads (new chat / history), and that list has
-- to update itself: a thread created by the hosted SSE endpoint or renamed by
-- its first turn is a row change the browser never sees otherwise. Every hook
-- already subscribes to `chat_threads` via useLiveQuery — the table simply was
-- not in the publication, so those subscriptions were silently inert.
do $$
begin
  begin
    alter publication supabase_realtime add table chat_threads;
  exception when duplicate_object then null;
  end;
end $$;

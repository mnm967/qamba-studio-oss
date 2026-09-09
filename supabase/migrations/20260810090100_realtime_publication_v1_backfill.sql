-- The v1-era tables were published by hand, so the migrations never described
-- the publication they produced. A database rebuilt from this directory came
-- up with no realtime on `jobs` or `pod_status` — the queue, the progress bars
-- and the pod chip — and nothing would have said so: an unpublished table is
-- simply a subscription that never fires.
--
-- Idempotent, and a no-op against the live DB, which already has all six.
-- Its real job is to make `supabase/migrations` reproduce the publication, so
-- realtimeTables.test.ts can check the client's REALTIME_TABLES against the
-- files and mean it.
do $$
declare t text;
begin
  foreach t in array array[
    'jobs', 'pod_status', 'episodes', 'shots', 'takes', 'references_'
  ] loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

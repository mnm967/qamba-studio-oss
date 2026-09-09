-- The desktop app is a worker too, and its work needs a lane of its own.
--
-- A render on the user's OWN ComfyUI is still a job: it wants a queue row so
-- the popover, the library placeholder card, `jobLabel`, cancel and the roll
-- history all keep working, and so a render survives a reload — the app
-- re-attaches to its ComfyUI prompt from `payload.prompt_id` rather than
-- losing a five-minute sample because someone hit refresh.
--
-- It must NOT be a `gpu` row. The pod claims by lane (`claim_next_job(p_lanes,
-- …)`, WORKER_LANES defaults to gpu,cpu,api,llm) and would happily pick up a
-- job meant for a laptop, render it on the $3.36/hr box, and bill for it. A
-- lane the pod does not serve is the whole enforcement: no code change on the
-- worker, and nothing to forget.
--
-- Invariant #1 is intact. It says the FRONTEND never talks to ComfyUI or the
-- POD — all pod work is a jobs row a pod worker claims, and that is untouched.
-- A `local` row is claimed by the machine that wrote it, over loopback, on
-- hardware the user owns.
alter table jobs drop constraint if exists jobs_lane_check;
alter table jobs add constraint jobs_lane_check
  check (lane in ('gpu', 'cpu', 'api', 'llm', 'local'));

-- `jobs` has NO update policy — the pod writes with the service key and the
-- browser's one legitimate write (cancel) goes through the SECURITY DEFINER
-- `request_job_cancel`. A local render needs to claim, report progress and
-- finish, so it needs the real thing, and the lane is what makes that safe to
-- grant: the row must ALREADY be `local` (USING) and must STAY `local` and
-- mine (WITH CHECK), so this cannot be used to claim, stall or rewrite a pod
-- job. Everything a pod job's row means is still service-key-only.
drop policy if exists jobs_update_local on jobs;
create policy jobs_update_local on jobs
  for update
  using (lane = 'local' and owner_id = auth.uid())
  with check (lane = 'local' and owner_id = auth.uid());

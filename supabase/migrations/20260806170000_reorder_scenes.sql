-- Dragging a scene into a new position on the storyboard.
--
-- `scenes` carries `unique (storyboard_id, idx)` and it is NOT deferrable, so a
-- permutation written row by row collides with a row it has not moved yet —
-- which is why every existing resequence (add_scene, delete_scene) shifts
-- back-to-front, a trick that only works for a shift by one. A drag is an
-- arbitrary permutation, so this parks the rows it is about to move at negative
-- idx first (unique among themselves, disjoint from the 0..n-1 the untouched
-- rows keep) and then writes the final values. One statement per phase, one
-- transaction: a failure leaves the old order, never a half-renumbered one.
-- That is the reason this is an RPC and not a loop of PATCHes from the client.
create or replace function reorder_scenes(p_storyboard uuid, p_ids uuid[])
returns int
language plpgsql
as $$
declare moved int;
begin
  -- The list has to name every scene in the storyboard exactly once. A partial
  -- list would renumber into gaps or duplicates; a stale one (a scene added in
  -- another tab since the drag started) would silently drop it out of the
  -- episode. Both cases are the caller re-reading and trying again.
  if (select count(*) from scenes where storyboard_id = p_storyboard)
       <> coalesce(array_length(p_ids, 1), 0)
     or exists (select 1 from scenes
                 where storyboard_id = p_storyboard and id <> all(p_ids))
  then
    raise exception 'reorder_scenes: p_ids must name every scene in storyboard % exactly once',
      p_storyboard using errcode = '22023';
  end if;

  update scenes s set idx = -1 - s.idx
    from unnest(p_ids) with ordinality as t(id, ord)
   where s.id = t.id and s.storyboard_id = p_storyboard and s.idx <> t.ord - 1;
  get diagnostics moved = row_count;

  update scenes s set idx = t.ord - 1
    from unnest(p_ids) with ordinality as t(id, ord)
   where s.id = t.id and s.storyboard_id = p_storyboard and s.idx < 0;

  -- Blocks span scenes and carry absolute t_start_ms/t_end_ms, so reordering
  -- invalidates the whole plan, not the moved scene's slice of it — same call
  -- add_scene/delete_scene make. The plan is rebuilt at launch.
  if moved > 0 then
    update generation_blocks set status = 'stale'
     where storyboard_id = p_storyboard and status in ('planned', 'generated');
  end if;
  return moved;
end;
$$;

-- The studio runs on the anon key (RLS here is open — see collection_hidden),
-- and anon can already UPDATE scenes directly; this only makes doing it safely
-- possible. Invoker rights on purpose: if RLS is ever tightened, this should
-- start failing, not quietly bypass it.
grant execute on function reorder_scenes(uuid, uuid[]) to anon;

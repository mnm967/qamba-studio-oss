-- WHICH TAKE ONE CLIP PLAYS, when that is not the block's own.
--
-- A block can sit on a cut more than once (⌘D on a block clip, a split, or —
-- since 2026-09-04 — dragging it from the shots rail a second time), and the
-- obvious reason to put a shot down twice is to show two different takes of
-- it. That was not expressible: `syncBlocksToTimeline` repoints EVERY clip of
-- a block at `generation_blocks.active_take_id`, and it has to — that repoint
-- is how "activate this take" reaches a lane the user was not looking at when
-- they pressed it. So a hand-picked take survived exactly until the next take
-- landed, the next re-render, or the next page load, and then silently became
-- the block's again.
--
-- `take_id` is the record that stops it, and it is a record for the same
-- reason `timelines.excluded_block_ids` is one: "this clip is deliberately
-- playing take 2" and "this clip has not caught up to take 3 yet" are the
-- same observation from outside, so nothing can be inferred from `asset_id`
-- alone. Null means FOLLOW THE BLOCK, which is every clip that exists today
-- and every clip anything else creates — so this column changes nothing until
-- somebody pins one.
--
-- `on delete set null` is the fallback: deleting a take a clip was pinned to
-- returns that clip to the block's own, rather than leaving it pointing at a
-- row that is gone.
-- UNQUALIFIED ON BOTH SIDES, like every other column in this directory, and
-- that is load-bearing rather than style: `scripts/sqlSchema.mjs` matches a
-- BARE table name on each, so `alter table public.clips` parses its table as
-- "public" and `references public.block_takes(id)` as no foreign key at all —
-- and `src/lib/localSchema.ts` is generated from that. Qualified, this column
-- would exist in the cloud and the local plane would never learn to clear the
-- pin when a take is deleted, leaving a clip pointed at a row that is gone.
-- (The `public.`-qualified statements already in this directory are all
-- dynamic SQL inside `execute format(...)`, which the parser is right to skip.)
alter table clips
  add column if not exists take_id uuid references block_takes(id) on delete set null;

comment on column clips.take_id is
  'The block take this clip deliberately plays. NULL = follow the block''s '
  'active_take_id, which is the default and what the sync repoints. Set only '
  'by a person choosing a take for one copy of a block that is on the cut '
  'more than once.';

-- The sync reads it per clip of a block it is already fetching by track, so
-- there is no lookup by take to index. This one is for the FK's own delete
-- check, which otherwise scans every clip whenever a take is removed.
create index if not exists clips_take_id_idx on clips (take_id)
  where take_id is not null;

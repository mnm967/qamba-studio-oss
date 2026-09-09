-- Lore gets a place in time.
--
-- Until now every lore fact was flat and timeless, which is wrong in a way that
-- only shows up as the story gets long. "Grief unlocks the power" is true — as
-- of Ep1's ending. By Ep2 the Stabilizing Presence reveal reframes it. Held as
-- co-equal timeless canon, the planner has no way to know which is the current
-- truth when writing Ep4, or that Ep1 should still read as the naive
-- understanding. Time-blind lore either contradicts itself in generation or
-- forces the author to catch every retcon by eye.
--
-- Two halves:
--
-- 1. `rag_documents.episode_id` — which episode a DOCUMENT belongs to. An
--    imported "Ep1-2 lore sheet" is about those episodes; a series bible is
--    about none of them. Entries extracted from a document inherit its episode,
--    which is what makes tagging cheap enough to actually happen.
--
-- 2. `bible_entries.doc.when` — per-FACT timing, as jsonb rather than columns.
--    It is three nullable episode references and it is read by exactly one
--    consumer (worker/llm.py's lore_context) which already loads the whole
--    bible and filters in Python. A column set plus a migration per shape
--    change would buy nothing here, and `doc` is where every other
--    writer-authored field on an entry already lives.
--
--    { "from": <episode uuid|null>,      -- true from this episode on
--      "until": <episode uuid|null>,     -- no longer true FROM this one (exclusive)
--      "revealed": <episode uuid|null> } -- the audience learns it here
--
--    All null = evergreen: a mechanical rule that does not change.
--    from == revealed = an ordinary fact, established when it is shown.
--    from < revealed  = a RETCON: operating all along, learned later. The
--                       planner must make the world behave this way while
--                       forbidding any character from stating it.
--    until set        = a fact that STOPS being true ("she doesn't know yet").
--
-- Episode UUIDs, not indexes: `episodes.idx` is a position and positions move.
-- Ordering comparisons resolve through the episode list at read time.

alter table rag_documents
  add column if not exists episode_id uuid references episodes(id) on delete set null;

create index if not exists rag_documents_episode_idx
  on rag_documents (episode_id) where episode_id is not null;

comment on column rag_documents.episode_id is
  'Which episode this document is about. Null = series-wide / evergreen. '
  'Entries extracted from it inherit this as their default doc.when.from.';

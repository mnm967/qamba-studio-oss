-- v2 director: chat threads/messages + RAG (pgvector) + realtime publication
-- for the new tables the UI subscribes to.

create extension if not exists vector with schema extensions;

create table if not exists chat_threads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  episode_id uuid references episodes(id) on delete set null,
  kind text not null default 'director' check (kind in ('director','wizard','task')),
  title text,
  persona jsonb,
  backend text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger chat_threads_updated before update on chat_threads
  for each row execute procedure extensions.moddatetime(updated_at);
create index if not exists chat_threads_project_idx on chat_threads (project_id, updated_at desc);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references chat_threads(id) on delete cascade,
  role text not null check (role in ('user','assistant','tool','system')),
  content jsonb not null,                -- Anthropic-style content blocks
  streaming boolean not null default false,
  tokens_in int,
  tokens_out int,
  cost_usd numeric(10,6),
  job_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_thread_idx on chat_messages (thread_id, created_at);

create table if not exists rag_documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,  -- null = global
  kind text not null check (kind in ('prompt_guide','script','lore','style_guide','reference')),
  title text not null,
  source text,
  created_at timestamptz not null default now()
);

create table if not exists rag_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references rag_documents(id) on delete cascade,
  idx int not null,
  content text not null,
  embedding extensions.vector(1536),     -- text-embedding-3-small
  meta jsonb not null default '{}'
);
create index if not exists rag_chunks_hnsw on rag_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

create or replace function match_rag_chunks(
  query_embedding extensions.vector(1536),
  p_project uuid default null,
  k int default 8
)
returns table (chunk_id uuid, document_id uuid, content text, title text,
               doc_kind text, similarity float)
language sql
stable
set search_path = public, extensions
as $$
  select c.id, c.document_id, c.content, d.title, d.kind,
         1 - (c.embedding <=> query_embedding) as similarity
  from rag_chunks c
  join rag_documents d on d.id = c.document_id
  where c.embedding is not null
    and (d.project_id is null or p_project is null or d.project_id = p_project)
  order by c.embedding <=> query_embedding
  limit k;
$$;

do $$
declare t text;
begin
  foreach t in array array['chat_threads','chat_messages','rag_documents','rag_chunks'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I_select on %I for select to public using (true)', t, t);
    execute format('create policy %I_insert on %I for insert to public with check (true)', t, t);
    execute format('create policy %I_update on %I for update to public using (true) with check (true)', t, t);
    execute format('create policy %I_delete on %I for delete to public using (true)', t, t);
  end loop;
end $$;

-- Realtime: publish the v2 tables the UI live-subscribes to.
do $$
declare t text;
begin
  foreach t in array array['generation_blocks','block_takes','scenes','storyboards',
                           'chat_messages','assets'] loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

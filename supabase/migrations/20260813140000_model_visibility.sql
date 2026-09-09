-- Which MODELS a member is offered, on the same footing as lora_visibility.
--
-- Plus the hole that one left open: `model_catalog.local_files` is the model_map
-- fragment, and it carries `style_loras` — every restricted adapter's KEY and
-- its FILENAME — so a member could read out of `local_files` exactly what
-- `capabilities.styleLoras` had just been filtered to hide. Nothing in the
-- browser reads that column (grep: one comment, no use), and "filenames never
-- reach the browser" is a rule this codebase already states, so the view now
-- withholds it from anyone but an admin.

create table if not exists model_visibility (
  model_id text primary key,          -- model_catalog.id, e.g. 'h3-turbo-local'
  -- The model_map key the same row travels as in a job payload
  -- (`payload.model_key`), written by the client from `modelKeyOf` so the
  -- mapping lives in ONE place. Deriving it again on the pod would be a third
  -- copy of MODEL_KEY_EXCEPTIONS, and CLAUDE.md already warns that the two
  -- existing copies must be kept identical.
  model_key text,
  visibility text not null default 'admins' check (visibility in ('everyone', 'admins')),
  note text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table model_visibility enable row level security;

create policy model_visibility_admin on model_visibility for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on model_visibility to authenticated;
grant all on model_visibility to service_role;

-- SECURITY DEFINER for the same reason `visible_style_loras` is: the view has
-- to consult a table the caller cannot read, and invoker rights would make the
-- test trivially false for every member — hiding nothing, silently.
create or replace function public.model_hidden(p_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.model_visibility v
                  where v.model_id = p_id and v.visibility = 'admins');
$$;
grant execute on function public.model_hidden(text) to public;

create or replace view model_catalog_visible
with (security_invoker = true) as
select id, family, display_name, kind, provider, modes, sizes, max_seconds,
       fps, frame_base, frame_rem, dim_step, pricing,
       public.visible_style_loras(capabilities) as capabilities,
       -- the model_map fragment, adapter filenames and all
       case when public.is_admin() then local_files else null end as local_files,
       enabled, sort, updated_at
  from public.model_catalog c
 where public.is_admin() or not public.model_hidden(c.id);
grant select on model_catalog_visible to authenticated;

-- Admin panel roster: every catalog row with its current setting.
create or replace function public.model_roster()
returns table (id text, display_name text, kind text, provider text,
               enabled boolean, visibility text)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.display_name, c.kind, c.provider, c.enabled,
         coalesce(v.visibility, 'everyone') as visibility
    from public.model_catalog c
    left join public.model_visibility v on v.model_id = c.id
   where public.is_admin()
   order by c.kind, c.sort, c.display_name;
$$;
revoke execute on function public.model_roster() from public, anon;
grant execute on function public.model_roster() to authenticated;

-- What the worker reads to enforce. Both spellings, because a job carries the
-- catalog id in `model_id` and the model_map key in `payload.model_key`.
create or replace function public.restricted_models()
returns table (model_id text, model_key text)
language sql
stable
security definer
set search_path = public
as $$
  select v.model_id, v.model_key
    from public.model_visibility v where v.visibility = 'admins';
$$;
revoke execute on function public.restricted_models() from public, anon;
grant execute on function public.restricted_models() to service_role;

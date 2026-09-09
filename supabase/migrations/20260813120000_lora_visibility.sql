-- Which LoRAs a member is offered.
--
-- The catalog carries a dozen adapters per checkpoint and a good many of them
-- are adult (`grit`, `duotone`, `inked`, `bloom`…). An admin needs
-- to decide which of those a non-admin account sees, and "sees" has to mean
-- the picker AND the render — hiding a row in the UI while the key still
-- resolves on the pod is the silent half-measure this codebase keeps writing
-- postmortems about.
--
-- So the filtering happens in TWO places, both server-side:
--   1. `model_catalog_visible` rewrites `capabilities.styleLoras` per caller,
--      so a restricted key never reaches the browser at all — not hidden by
--      the client, absent from the payload it was sent.
--   2. the worker drops restricted keys off a claimed job's payload
--      (worker.py), because a job row is just JSON and nothing stops a client
--      from putting a key it never saw into one.
--
-- Keyed by LORA KEY ALONE, not (model, key). Two reasons: the same adapter is
-- declared on several checkpoints (`minimax-h3` and `minimax-h3-turbo` share
-- the whole HM set), and an admin hiding "inked" means everywhere
-- rather than on one row of a picker; and the browser's `model_key` is a
-- model_map key while the catalog's is a catalog id — `modelKeyOf`'s
-- exception table exists precisely because those two disagree, and keying on
-- the pair would have re-imported that bug into the enforcement path.

create table if not exists lora_visibility (
  lora_key text primary key,
  visibility text not null default 'admins' check (visibility in ('everyone', 'admins')),
  note text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table lora_visibility enable row level security;

-- Admin-only, both ways. A member never reads this table — the view below does
-- the filtering on their behalf, so the restricted keys are not merely hidden
-- from the picker, they are never sent.
create policy lora_visibility_admin on lora_visibility for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on lora_visibility to authenticated;
grant all on lora_visibility to service_role;

-- SECURITY DEFINER, and that is the whole trick: the view has to consult a
-- table the caller cannot read. Invoker rights here would make the NOT EXISTS
-- trivially true for every member — filtering nothing, silently, which is the
-- exact inversion this feature must not have.
create or replace function public.visible_style_loras(p_caps jsonb)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.is_admin() then p_caps
    when p_caps ? 'styleLoras' then jsonb_set(p_caps, '{styleLoras}', (
      select coalesce(jsonb_agg(e), '[]'::jsonb)
        from jsonb_array_elements(p_caps -> 'styleLoras') e
       where not exists (
         select 1 from public.lora_visibility v
          where v.visibility = 'admins'
            -- an entry is either {key,label,…} or a bare string
            and v.lora_key = coalesce(e ->> 'key', e #>> '{}'))
    ), false)
    else p_caps
  end;
$$;
grant execute on function public.visible_style_loras(jsonb) to public;

-- The catalog as this account may see it. `security_invoker` so model_catalog's
-- own policy still decides who gets rows at all (authenticated, not anon);
-- only the LoRA list is rewritten.
create or replace view model_catalog_visible
with (security_invoker = true) as
select id, family, display_name, kind, provider, modes, sizes, max_seconds,
       fps, frame_base, frame_rem, dim_step, pricing,
       public.visible_style_loras(capabilities) as capabilities,
       local_files, enabled, sort, updated_at
  from public.model_catalog;
grant select on model_catalog_visible to authenticated;

-- What the admin panel enumerates: every adapter the catalog declares, with the
-- models that declare it, and its current setting. Admin-only.
create or replace function public.lora_roster()
returns table (lora_key text, label text, models text[], visibility text)
language sql
stable
security definer
set search_path = public
as $$
  select k.lora_key,
         min(k.label) as label,
         array_agg(distinct k.model_id order by k.model_id) as models,
         coalesce(min(v.visibility), 'everyone') as visibility
    from (
      select c.id as model_id,
             coalesce(e ->> 'key', e #>> '{}') as lora_key,
             coalesce(e ->> 'label', e #>> '{}') as label
        from public.model_catalog c,
             lateral jsonb_array_elements(coalesce(c.capabilities -> 'styleLoras', '[]'::jsonb)) e
       where public.is_admin()
    ) k
    left join public.lora_visibility v on v.lora_key = k.lora_key
   group by k.lora_key
   order by 1;
$$;
revoke execute on function public.lora_roster() from public, anon;
grant execute on function public.lora_roster() to authenticated;

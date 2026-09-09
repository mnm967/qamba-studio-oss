-- The public read behind /f/:slug, applied by hand while the share page was
-- being built and recorded here after the fact.
--
-- SUPERSEDED IN THE VERY NEXT MIGRATION, which re-creates this function with
-- the grants stated explicitly — see the note there about Supabase's default
-- privileges. It is kept as its own file rather than folded away because the
-- live ledger records it as a separate applied version, and a directory that
-- cannot reproduce the ledger is one nobody can rebuild from.
create or replace function public.public_film(p_slug text)
returns table (title text, synopsis text, video_key text, poster_key text,
               width integer, height integer, duration_ms integer)
language sql stable security definer set search_path = public
as $$
  select s.title, s.synopsis, a.b2_key, p.b2_key, a.width, a.height, a.duration_ms
    from public.film_shares s
    join public.assets a on a.id = s.asset_id
    left join public.assets p on p.id = s.poster_asset_id
   where s.slug = p_slug
     and s.visibility <> 'revoked'
     and a.deleted_at is null;
$$;

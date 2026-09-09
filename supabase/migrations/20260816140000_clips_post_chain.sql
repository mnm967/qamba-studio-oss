-- clips.post — the finishing passes this clip gets in the FINAL render.
--
-- NULL is "inherit the project's chain" and is the default, so every existing
-- clip keeps following projects.settings.post without a backfill. An object
-- ({} included) is an override: `{}` means this clip deliberately gets nothing,
-- which is a different statement from NULL and has to stay distinguishable.
--
-- Shape mirrors src/lib/postChain.ts PostChain / worker/post_chain.py:
--   {"upscale":true,"interpolate":true,"facefix":true,"color_match":true,"grain":true}
-- Only keys that are ON need to be present.
alter table clips add column if not exists post jsonb;

comment on column clips.post is
  'Post-processing chain applied by tl_render. NULL = inherit projects.settings.post; '
  'an object overrides it ({} = no passes). Keys: upscale, interpolate, facefix, '
  'color_match, grain.';

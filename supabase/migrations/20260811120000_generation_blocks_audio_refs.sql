-- The staged dialogue truth for a block, written by the worker at master-pass
-- staging time: [{slot, kind: line|exchange|voice, asset_id, name?/text?/
-- lines?/start?}]. The block panel plays these exact clips; NULL until the
-- block has staged audio at least once (or when it staged none).
alter table generation_blocks add column if not exists audio_refs jsonb;

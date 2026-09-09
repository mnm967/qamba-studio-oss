"""Job registry: kind -> handler.

`plan_cli.py` is the only caller — it claims one job, looks the handler up
here, and runs it. Each group imports lazily so a kind whose optional
dependency is absent (Pillow for a segment board, ffmpeg for an assembly)
fails when it is asked for rather than at import.

`plan_cli.KINDS` is the ALLOW-LIST and this is the DISPATCH TABLE. Both exist
because they answer different questions — "may this build run that kind" and
"what runs it" — and a kind present in one and missing from the other is a job
that queues and then dies in the dispatcher with nothing to explain it.
"""
from . import ingest

REGISTRY = {
    "asset_ingest": ingest.handle_asset_ingest,
}


def resolve_handler(job):
    kind = job.get("kind")
    fn = REGISTRY.get(kind)
    if fn is not None:
        return fn
    if kind in ("launch_render", "master_pass", "patch_flf", "patch_splice",
                "assemble_take", "block_from_clip", "video_edit", "transition_gen",
                "audio_slice", "clip_gen"):
        from . import blocks
        return blocks.resolve(kind)
    if kind in ("clip_render", "tl_render", "frame_extract"):
        from . import render
        return render.resolve(kind)
    if kind in ("image_gen", "sheet_compose"):
        from . import images
        return images.resolve_kind(kind)
    if kind == "music_gen":
        from . import music
        return music.resolve_kind(kind)
    if kind == "sfx_gen":
        from . import sfx
        return sfx.resolve_kind(kind)
    if kind == "v2a_gen":
        from . import v2a
        return v2a.resolve_kind(kind)
    if kind == "orbit_sheet":
        from . import orbit
        return orbit.handle_orbit_sheet
    if kind == "assemble_cut":
        from . import cut
        return cut.handle_assemble_cut
    # `post_ltx_refine` was missing here while `post.resolve()` had handled it
    # all along — so that job kind queued and then died on a KeyError in the
    # dispatcher rather than in anything that could explain it. Nothing emits
    # it today (the refine reaches clips through the post CHAIN), which is why
    # it survived; a dead kind sitting beside a live one is how the next one
    # gets forgotten too.
    if kind in ("post_upscale", "post_interpolate", "post_facefix",
                "post_h3_facefix", "post_ltx_refine", "post_grain_color",
                "image_upscale", "gc_sweep"):
        from . import post
        return post.resolve(kind)
    if kind in ("llm_task", "embed"):
        import llm
        return llm.resolve(kind)
    if kind == "tts":
        from . import tts
        return tts.handle_tts
    if kind == "voice_clone":
        from . import voice
        return voice.resolve_kind(kind)
    return None

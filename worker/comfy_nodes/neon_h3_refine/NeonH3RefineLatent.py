"""Rebuild MiniMax H3's joint AV latent for a second sampler pass.

H3 samples ONE nested video+audio latent, so a refinement pass cannot simply
re-encode an upscaled picture and sample it: the sampler is handed a
`NestedTensor((video, audio))` and a bare video latent has no audio half to
pair with. `comfy_extras` ships no H3 concat node (LTX has
`LTXVConcatAVLatent`; H3 does not), which is why vrgamedevgirl's own two-pass
graph reaches for a third-party `PT_H3ConcatAVLatent`.

This is that node, written against the one piece of the shape we already had
in the tree: `vrgdg_audiodrive/VRGDG_MiniMaxH3AudioDrive.py` builds exactly
this tensor, and its zero-mask trick is what proves core honours a nested
`noise_mask` through `SamplerCustomAdvanced`.

Two deliberate differences from her graph, both because our audio is GENERATED
where hers is a locked source track:

  * The audio half is taken straight off pass 1's sampled latent rather than
    decoded to a waveform and re-encoded. She round-trips because she is about
    to overwrite the result with the user's own file anyway; for us the round
    trip is pure loss with nothing to gain.
  * The audio half is FROZEN for the second pass (zero noise mask), so the
    refine samples a picture against unperturbed sound rather than against a
    re-noised guess. That is the SAME job the mask does in her graph — and it
    is NOT what makes the delivered audio match. Measured: with the audio
    decoded from the refined latent, a 4.5s block came back at 0.937
    correlation and 8.9 dB SNR against the take it refines, i.e. audibly a
    different render. Her graph never relied on the mask for that either; it
    re-muxes the user's own waveform afterwards ("the VAE round-trip is only
    for model conditioning"). Our equivalent is `resolve._splice_h3_refine`
    leaving `VAEDecodeAudio` wired to PASS 1, which makes the match true by
    construction. This node only has to not corrupt the audio half.
"""
import torch

import comfy.nested_tensor


def _parts(av_latent):
    if not isinstance(av_latent, dict) or "samples" not in av_latent:
        raise ValueError("Neon H3 Refine Latent requires an AV LATENT input.")
    samples = av_latent["samples"]
    if not getattr(samples, "is_nested", False):
        raise ValueError(
            "Neon H3 Refine Latent expected a joint video+audio latent. Connect "
            "the LATENT output of the first pass's SamplerCustomAdvanced."
        )
    parts = list(samples.unbind())
    if len(parts) < 2:
        raise ValueError(
            "Neon H3 Refine Latent could not find the audio half of the AV latent."
        )
    return parts[0], parts[1]


class NeonH3RefineLatent:
    """Pair a re-encoded (upscaled) video latent with pass 1's audio latent."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "av_latent": ("LATENT", {
                    "tooltip": "The first pass's sampled joint AV latent. Only its "
                               "AUDIO half is used; the video half is replaced."
                }),
                "video_latent": ("LATENT", {
                    "tooltip": "The upscaled first-pass picture, re-encoded through "
                               "the H3 video VAE."
                }),
                "freeze_audio": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Hold the audio exactly as pass 1 rendered it "
                               "(zero noise mask). Turn off only to let the refine "
                               "pass re-sample the soundtrack as well.",
                }),
            }
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("av_latent",)
    FUNCTION = "rebuild"
    CATEGORY = "Neon/H3"
    DESCRIPTION = (
        "Rebuilds MiniMax H3's nested video+audio latent from a refreshed video "
        "latent and the audio half of an earlier pass, so a second "
        "SamplerCustomAdvanced can refine the picture at a higher resolution."
    )

    def rebuild(self, av_latent, video_latent, freeze_audio=True):
        if not isinstance(video_latent, dict) or "samples" not in video_latent:
            raise ValueError("Neon H3 Refine Latent requires a video LATENT input.")
        _, audio = _parts(av_latent)
        video = video_latent["samples"]
        if getattr(video, "is_nested", False):
            # A caller wired the AV latent into both inputs. Take its video half
            # rather than nesting a nested tensor, which fails much later and
            # much less legibly.
            video = list(video.unbind())[0]
        audio = audio.to(device=video.device)

        out = dict(av_latent)
        out.pop("noise_mask", None)
        out["samples"] = comfy.nested_tensor.NestedTensor((video, audio))
        if freeze_audio:
            out["noise_mask"] = comfy.nested_tensor.NestedTensor((
                torch.ones_like(video),
                torch.zeros_like(audio),
            ))
        return (out,)


NODE_CLASS_MAPPINGS = {"NeonH3RefineLatent": NeonH3RefineLatent}
NODE_DISPLAY_NAME_MAPPINGS = {"NeonH3RefineLatent": "Neon H3 Refine Latent"}

"""Real per-step sampler previews for MiniMax H3, decoded by Kijai's tiny
autoencoder instead of Latent2RGB's colour approximation.

ComfyUI picks a previewer from `latent_format.taesd_decoder_name`, and
`MiniMaxH3Video` leaves it None — so every H3 render falls to Latent2RGB, a
24x3 linear map that yields colour blobs rather than a picture. Kijai's taeh3
(the engine window's model list h3-tae) is a real decoder for those latents, but core cannot
load it: `comfy.taesd`'s Decoder is hardwired to 64 channels and THREE
upsamples, and this file is 96 channels tapering to 64 with FOUR — H3 compresses
space by 16, not 8. Upstream has no support for it either (Comfy-Org/ComfyUI
issue #15592: open, no PR), so the architecture has to come from here.

Why a previewer and not one of the two community packs: both
(simsim9-stack/ComfyUI-MiniMaxH3-PreviewOverride,
cicalooo/ComfyUI-MiniMaxH3-LivePreview) paint into their own DOM widget on the
ComfyUI page, and one ships its own separately-trained decoder. Nothing in this
studio watches that page — the worker taps the websocket's PREVIEW_IMAGE frames
(`worker/comfy.py` `_PreviewTap`) and publishes them as `jobs.preview_key`.
Going through ComfyUI's OWN previewer is what keeps that transport intact, and
it is also what makes this cover every H3 graph — i2v / t2v / flf / r2v and the
image path, plain and turbo alike — without touching a single template: the
hook keys off the LATENT FORMAT, and turbo swaps the sampler, not the model.

A preview is a STRIP, not a frame: `temporal_downscale_ratio` is 4, so a
13.7s block carries ~82 latent frames and `x0` holds the whole shot at every
step — decoding index 0 and discarding the rest was throwing the movement away.
Four of them are decoded and joined into one sheet, which is still one JPEG
down the one channel ComfyUI has (`server.send_image` re-encodes a single PIL
image, so an animated WebP is not on the table). `strip.py` owns the layout and
the browser twin that reads it back. That much is borrowed from
ComfyUI-MiniMaxH3-PreviewOverride, which samples the same way; its transport is
not, because it paints into a DOM widget on a page nothing here watches.

Nothing here may raise into a render. A missing file, a checkpoint that doesn't
fit the architecture, or a decode that fails once all fall back to the previewer
core would have built anyway — i.e. to exactly today's behaviour.
"""
import logging
import os
import time

import torch

import comfy.latent_formats
import comfy.utils
import folder_paths
import latent_preview
from comfy.cli_args import args, LatentPreviewMethod
from comfy.taesd.taesd import Block, Clamp, conv

from . import strip

TAE_FILE = "taeh3.safetensors"

# This decode runs INSIDE the sampler callback, next to a ~84GB H3 working set
# on a 96GB card, and it is 16x spatial — so a full-frame decode's activations
# are ~500MB+ at the last stage, which is enough to lose the race for the last
# of the VRAM. It did: b18 OOM'd in SamplerCustomAdvanced on the first render
# after this shipped, where b17 (same episode, same kind of block) had passed
# without it. Three bounds, so a preview cannot compete with the render that
# gives it its subject:
#   * decode a DOWNSCALED latent — the preview is a queue thumbnail, and core
#     resizes to args.preview_size after us anyway, so full resolution was
#     being computed and then thrown away. The strip spends that same budget
#     across its cells rather than on top of it (4 x 256px against one 512px),
#     so sampling the shot costs no more VRAM than the single frame did;
#   * decode at most every MIN_INTERVAL_S and reuse the last frame between —
#     the callback fires every step, while the worker only publishes every 6s;
#   * skip entirely when free VRAM is under MIN_FREE_MB.
# NOTE MAX_PX is the long side of the whole SHEET, not of one cell — it was the
# frame's own long side while a preview was one frame. It is unset in
# /etc/comfyui.env, so the default is what runs; keep it at or under ComfyUI's
# --preview-size or core silently downscales the sheet and the cells go soft.
MAX_PX = int(os.environ.get("NEON_H3_PREVIEW_MAX_PX", str(strip.SHEET_PX)))
# Cells per strip. 1 restores the single frame exactly, at its old size.
FRAMES = int(os.environ.get("NEON_H3_PREVIEW_FRAMES", str(strip.FRAMES)))
MIN_INTERVAL_S = float(os.environ.get("NEON_H3_PREVIEW_INTERVAL_S", "3"))
MIN_FREE_MB = int(os.environ.get("NEON_H3_PREVIEW_MIN_FREE_MB", "4096"))
# Kill switch, because the thing this competes with costs $3.36/hr and a render
# is worth more than the picture of it: `NEON_H3_PREVIEW=0` in /etc/comfyui.env
# gives back plain Latent2RGB with no code change and no deploy.
ENABLED = os.environ.get("NEON_H3_PREVIEW", "1") not in ("0", "false", "no")

# One decoder for the process, built on first use. `disabled` is one-way: once
# anything about this path has failed we stay on Latent2RGB rather than
# re-trying inside a sampler callback every step of every render.
_state = {"decoder": None, "tried": False, "disabled": False}


def build_decoder(sd):
    """The taeh3 decoder, rebuilt from the checkpoint's own keys.

    These decoders are a flat `nn.Sequential` keyed by module POSITION
    ("1.weight", "13.conv.0.weight"), so the architecture is recoverable from
    the file rather than something we have to know: an index carrying
    `conv.0.weight` is a Block, one carrying a bare `weight` is a conv (the
    bias-less ones are the post-upsample convs), and the missing indices are
    the parameterless modules. Deriving it beats hardcoding H3's shape because
    the shape is unusual in two ways at once — 96 channels for the first half
    where core's Decoder is always 64, and FOUR upsamples for H3's 16x spatial
    compression where core has three — and a retrained TAE could move either.

    `strict=True` is the check on all of it: a file this doesn't reconstruct
    exactly fails here, and we keep Latent2RGB rather than decode garbage.
    """
    by_index = {}
    for key, tensor in sd.items():
        head, _, rest = key.partition(".")
        if not head.isdigit():
            raise ValueError(f"taeh3 should be a flat index-keyed decoder; got '{key}'")
        by_index.setdefault(int(head), {})[rest] = tensor

    layers = []
    for i in range(max(by_index) + 1):
        part = by_index.get(i)
        if part is None:
            # Index 0 clamps the incoming latent and 2 is the ReLU after the
            # input conv — every other gap is an upsample, which is where the
            # 16x comes from in a file that never states it.
            layers.append(Clamp() if i == 0 else
                          torch.nn.ReLU() if i == 2 else
                          torch.nn.Upsample(scale_factor=2))
        elif "conv.0.weight" in part:
            w = part["conv.0.weight"]
            layers.append(Block(w.shape[1], w.shape[0]))
        elif "weight" in part:
            w = part["weight"]
            layers.append(conv(w.shape[1], w.shape[0], bias="bias" in part))
        else:
            raise ValueError(f"unrecognised taeh3 module at index {i}: {sorted(part)}")

    dec = torch.nn.Sequential(*layers)
    dec.load_state_dict(sd, strict=True)
    return dec.eval()


class TAEH3Previewer(latent_preview.LatentPreviewer):
    def __init__(self, decoder, device, fallback):
        self.decoder = decoder
        self.device = device
        self.fallback = fallback
        self.latent_channels = decoder[1].weight.shape[1]
        self.upscale = 2 ** sum(isinstance(m, torch.nn.Upsample) for m in decoder)
        self.dtype = None
        self.last = None        # newest decoded frame, reused between decodes
        self.last_at = 0.0

    def _fallback(self, x0):
        """The cheap preview, or a blank. `fallback` can legitimately be None:
        core's own previewer raises on 0.34.2 for exactly this latent format
        (see _core_previewer), and a format with no latent_rgb_factors leaves
        nothing to build. Returning None from here is what core does when it
        has no previewer at all, and `prepare_callback` guards for it."""
        fb = self.fallback
        if fb is None:
            return None
        try:
            return fb.decode_latent_to_preview(x0)
        except Exception:            # noqa: BLE001 — decoration, never a render
            return None

    def decode_latent_to_preview(self, x0):
        if _state["disabled"]:
            return self._fallback(x0)
        now = time.time()
        if self.last is not None and now - self.last_at < MIN_INTERVAL_S:
            return self.last
        if not self._has_headroom():
            # Not a failure — the render is simply using the card right now.
            # Keep showing the last real frame rather than flickering between
            # a decoded one and a Latent2RGB one.
            return self.last if self.last is not None else self._fallback(x0)
        try:
            self.last = self._decode(x0)
            self.last_at = now
            return self.last
        except Exception as e:
            # Once, then never again this process. A preview is decoration, and
            # a render that dies for one is the straight downgrade this codebase
            # keeps getting bitten by; Latent2RGB still conveys motion, which is
            # most of what a watcher is looking for.
            _state["disabled"] = True
            logging.warning("neon_h3_preview: taeh3 decode failed, falling back "
                            "to latent2rgb for this process (%s)", e)
            return self._fallback(x0)

    def _has_headroom(self):
        if self.device is None or getattr(self.device, "type", None) != "cuda":
            return True
        try:
            free, _total = torch.cuda.mem_get_info(self.device)
        except Exception:
            return True     # can't tell — the try/except around the decode stands
        return free >= MIN_FREE_MB * 1024 * 1024

    def _decode(self, x0):
        # H3 samples video AND audio out of one latent. Core's callback de-nests
        # to the video stream before a previewer sees it; guard anyway, since
        # the turbo pack brings its own sampler and only core's path is covered
        # by that.
        if getattr(x0, "is_nested", False):
            x0 = x0.tensors[0]
        # (B, C, T, H, W). MiniMaxH3AV widens latent_channels to 32 to hold the
        # audio stream whole; the decoder wants the 24 video ones. 4D shows up
        # when a caller has squeezed T away.
        seq = (x0[0, :self.latent_channels] if x0.ndim == 5
               else x0[0, :self.latent_channels].unsqueeze(1))       # (C, T, H, W)
        t, lat_h, lat_w = seq.shape[1], seq.shape[2], seq.shape[3]
        plan = strip.strip_plan(t, lat_w, lat_h, frames=FRAMES, sheet_px=MAX_PX)
        if self.dtype is None:
            # Follow the sampler's own precision rather than forcing fp32: this
            # runs beside H3's working set, and the activations at cell size are
            # the only part of it worth counting.
            self.dtype = (seq.dtype if seq.dtype in (torch.float16, torch.bfloat16)
                          else torch.float32)
            self.decoder = self.decoder.to(device=self.device, dtype=self.dtype)
        # Shrink the LATENT, not the decoded frame: at 16x, every pixel of
        # output we throw away afterwards cost 16x its own area in activations
        # on the way there. Area, not width — memory goes as the product.
        cell_wh = strip.cell_latent(lat_w, lat_h, plan.cell_px, self.upscale)
        # ONE CELL AT A TIME, not one batched forward pass. The two decode the
        # same total pixels, but a batch holds every cell's activations at once
        # where the loop peaks at one — and the thing this competes with for the
        # last of the VRAM is the render that gives it its subject.
        cells = []
        with torch.no_grad():
            for k in plan.indices:
                cell = seq[:, k].unsqueeze(0).to(device=self.device, dtype=self.dtype)
                if cell_wh != (lat_w, lat_h):
                    cell = torch.nn.functional.interpolate(
                        cell, size=(cell_wh[1], cell_wh[0]),
                        mode="bilinear", align_corners=False)
                cells.append(self.decoder(cell)[0])
        # Joined along the frame's LONG axis, which is what lets the browser
        # read the layout back off the sheet's pixel size alone — see strip.py.
        sheet = (cells[0] if len(cells) == 1
                 else torch.cat(cells, dim=-1 if plan.horizontal else -2))
        # The decoder's own output is 0..1, so it is passed through as-is —
        # like core's video-TAE previewer and unlike its TAESD one, which
        # re-centres a decode that has already been mapped to -1..1.
        return latent_preview.preview_to_image(sheet.float().movedim(0, 2), do_scale=False)


def _load_decoder():
    if _state["tried"]:
        return _state["decoder"]
    _state["tried"] = True
    path = folder_paths.get_full_path("vae_approx", TAE_FILE)
    if not path:
        logging.warning("neon_h3_preview: %s not found in models/vae_approx — H3 "
                        "previews stay on latent2rgb (fetch: bash the engine window's model list h3-tae)",
                        TAE_FILE)
        _state["disabled"] = True
        return None
    try:
        _state["decoder"] = build_decoder(comfy.utils.load_torch_file(path, safe_load=True))
        logging.info("neon_h3_preview: loaded %s — MiniMax H3 sampler previews "
                     "are real frames", path)
    except Exception as e:
        logging.warning("neon_h3_preview: could not load %s (%s) — H3 previews "
                        "stay on latent2rgb", path, e)
        _state["disabled"] = True
    return _state["decoder"]


def _is_h3(latent_format):
    h3 = getattr(comfy.latent_formats, "MiniMaxH3Video", None)
    if h3 is not None and isinstance(latent_format, h3):
        return True
    # Name check too: the class is young and has already grown one subclass
    # (MiniMaxH3AV). An upstream rename should cost us the TAE, not raise.
    return type(latent_format).__name__ in ("MiniMaxH3Video", "MiniMaxH3AV")


# Wrap rather than replace: VideoHelperSuite hooks this same function, and
# whichever of us loads second has to keep the other's behaviour. (VHS only
# engages when the WORKFLOW carries its own extra_pnginfo setting, which an
# API-format graph never does, so in this studio it passes core straight
# through — but that is its choice to make, not ours to assume.)
_chained_get_previewer = latent_preview.get_previewer


def _core_previewer(device, latent_format, *a, **kw):
    """Core's previewer, or None — never an exception.

    ComfyUI 0.34.2 (#15695) started claiming `taeh3` NATIVELY: it puts the
    name in `VIDEO_TAES` and builds a full `comfy.sd.VAE` out of whatever
    `models/vae_approx/taeh3*` it finds, then sets
    `taesd.first_stage_model.show_progress_bar`. Kijai's `taeh3.safetensors`
    — the file this pack was written for, and the one the fetch target pulls
    — is raw TAE weights that `VAE()` cannot auto-detect, so it logs "No VAE
    weights detected" and leaves `first_stage_model` None, and that attribute
    write raises.

    It raises inside `prepare_callback`, which every sampler calls, so the
    blast radius is EVERY H3 render on the box rather than a lost preview:
    measured on the 0.34.2 upgrade as 15 straight `image_gen` failures with
    `SamplerCustomAdvanced #11: AttributeError`. A preview is decoration and
    must never fail a render, so core's half is contained here and this pack
    — which does know how to read that file — carries on.
    """
    try:
        return _chained_get_previewer(device, latent_format, *a, **kw)
    except Exception as e:                       # noqa: BLE001 — see above
        if not _state.get("core_warned"):
            _state["core_warned"] = True
            logging.warning(
                "neon_h3_preview: core's own previewer raised (%s: %s) — "
                "using this pack's decoder and a latent2rgb fallback. On "
                "ComfyUI 0.34.2 this is core's native taeh3 branch failing to "
                "load Kijai's taeh3.safetensors.", type(e).__name__, e)
        return None


def _latent2rgb(latent_format):
    """The cheap previewer, built directly — what core would have returned had
    its TAESD branch not raised first."""
    try:
        if getattr(latent_format, "latent_rgb_factors", None) is None:
            return None
        return latent_preview.Latent2RGBPreviewer(
            latent_format.latent_rgb_factors,
            getattr(latent_format, "latent_rgb_factors_bias", None),
            getattr(latent_format, "latent_rgb_factors_reshape", None))
    except Exception:                            # noqa: BLE001
        return None


def get_previewer(device, latent_format, *a, **kw):
    core = _core_previewer(device, latent_format, *a, **kw)
    # Only where a real decode was actually asked for. `--preview-method
    # latent2rgb` is someone saying they want the cheap one; none means off.
    if (ENABLED
            and args.preview_method in (LatentPreviewMethod.Auto, LatentPreviewMethod.TAESD)
            and _is_h3(latent_format)):
        decoder = _load_decoder()
        if decoder is not None:
            # `fallback` is consulted on every throttle/VRAM/decode miss, so it
            # has to be a real previewer even when core handed back nothing.
            return TAEH3Previewer(decoder, device,
                                  core or _latent2rgb(latent_format))
    return core if core is not None else _latent2rgb(latent_format)


latent_preview.get_previewer = get_previewer

# No nodes — this pack is the hook above. ComfyUI still expects the mappings.
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "build_decoder", "TAEH3Previewer"]

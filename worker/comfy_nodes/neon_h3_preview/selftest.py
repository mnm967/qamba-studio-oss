"""Check taeh3 against the architecture in __init__ — run on the pod.

    cd /home/ubuntu/ComfyUI && /home/ubuntu/comfy-venv/bin/python \
        custom_nodes/neon_h3_preview/selftest.py

Everything this asserts is silent in production: a strict-load failure only
costs the TAE (we keep Latent2RGB), and a wrong output RANGE renders washed-out
previews that look like a model problem rather than a scaling one. Worth
re-running after a ComfyUI upgrade or a retrained TAE.
"""
import os
import sys

# Two different roots: the package is imported from custom_nodes/, while
# `comfy` and `folder_paths` come from the ComfyUI root — which is the cwd the
# docstring asks for, and is NOT sys.path[0] (that is this file's own dir).
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))
sys.path.insert(0, os.environ.get("COMFY_ROOT") or os.getcwd())

import torch  # noqa: E402

import comfy.utils  # noqa: E402
import folder_paths  # noqa: E402

from neon_h3_preview import TAE_FILE, TAEH3Previewer, build_decoder  # noqa: E402
from neon_h3_preview import strip  # noqa: E402


def check_strip(dec):
    """Decode a synthetic latent through the real previewer and read it back.

    This is the half no unit test can reach: `strip.py`'s arithmetic is pinned
    off-pod by `worker/tests/test_h3_preview_strip.py`, but the slicing, the
    resize and the join are torch, and getting any of them wrong is silent —
    a sheet joined on the wrong axis, or built from `x0[:, k]` instead of
    `x0[k]`, still publishes a perfectly valid JPEG of the wrong thing.

    The claim being checked is the round trip the browser depends on: the
    layout has to be recoverable from the finished sheet's pixel size alone.
    """
    prev = TAEH3Previewer(dec, torch.device("cpu"), fallback=None)
    ok = True
    for label, (lat_w, lat_h), t, want in [
        ("landscape 1280x736", (80, 46), 20, (strip.FRAMES, 1)),
        ("portrait 736x1280", (46, 80), 20, (1, strip.FRAMES)),
        ("square", (52, 52), 20, (strip.FRAMES, 1)),
        ("short latent", (80, 46), 2, (strip.FRAMES, 1)),
        ("image path (T=1)", (64, 64), 1, (1, 1)),
    ]:
        img = prev._decode(torch.randn(1, prev.latent_channels, t, lat_h, lat_w))
        got = strip.read_strip(*img.size)
        cells = want[0] * want[1]
        # The cells must also actually TILE the sheet, or the join produced a
        # sheet of the right shape by accident.
        tiles = (img.size[0] % want[0] == 0 and img.size[1] % want[1] == 0)
        good = got == want and tiles
        ok = ok and good
        print(f"  {'OK ' if good else 'FAIL'} {label}: {t} latent frames -> "
              f"sheet {img.size[0]}x{img.size[1]} -> read as {got[0]}x{got[1]} "
              f"({cells} cell{'s' if cells > 1 else ''})")
    return ok


def main():
    path = folder_paths.get_full_path("vae_approx", TAE_FILE)
    if not path:
        print(f"FAIL: {TAE_FILE} not in models/vae_approx")
        return 1
    sd = comfy.utils.load_torch_file(path, safe_load=True)
    print(f"loaded {path}: {len(sd)} tensors")

    dec = build_decoder(sd)                      # strict — raises on a mismatch
    print("OK: strict load, architecture matches the checkpoint")

    ups = sum(isinstance(m, torch.nn.Upsample) for m in dec)
    lat_ch = sd["1.weight"].shape[1]
    # 46x80 latent = a 736x1280 frame, the native H3 size these renders use.
    x = torch.randn(1, lat_ch, 46, 80)
    with torch.no_grad():
        out = dec(x)
    print(f"decode {tuple(x.shape)} -> {tuple(out.shape)}")
    assert out.shape[-2:] == (46 * 2**ups, 80 * 2**ups), "upscale != the upsample count"
    assert 2**ups == 16, f"expected H3's 16x spatial compression, got {2**ups}x"
    print(f"OK: {2**ups}x spatial upscale ({ups} upsample stages), {lat_ch} latent channels")

    # Reported, deliberately not asserted: the output convention is [0,1] (the
    # TAE family's), but random noise is out of distribution and overshoots
    # both ends, so this number cannot prove it either way. The real check is a
    # rendered preview that isn't washed out or inverted.
    print(f"output range on noise: {out.min():.3f} .. {out.max():.3f} "
          f"(convention is [0,1] -> preview_to_image(do_scale=False))")

    print("strip round trip (sheet -> layout, which is all the browser gets):")
    if not check_strip(dec):
        print("FAIL: a sheet does not read back as the layout it was built as")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

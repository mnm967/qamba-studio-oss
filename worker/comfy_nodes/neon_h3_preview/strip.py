"""Which frames of an H3 latent go into a preview strip, and how the browser
reads the sheet back.

Pure arithmetic — no torch, no ComfyUI — because the pack's `__init__` imports
both at module scope and so cannot be imported off the pod (the same reason
`selftest.py` exists). `src/lib/previewStrip.ts` is the browser twin, and
`worker/tests/test_h3_preview_strip.py` pins the pair: the two halves are
written in different languages and a disagreement about FRAMES or about which
axis the strip runs along is not an error, it is a preview cropped into the
wrong quarter of itself.

WHY THE SHEET IS SELF-DESCRIBING, which is the whole design. A preview arrives
at the browser as a bare JPEG URL with no metadata channel: ComfyUI's wire
format is `4-byte event | 4-byte image format | image` and nothing else
(`worker/comfy.py` `_PreviewTap`), `jobs.preview_key` is written once per job,
and the B2 bucket sends no ACAO so the pixels cannot be read into a canvas to
be measured. All the browser ever gets is `naturalWidth x naturalHeight`.

So the layout is encoded in that: THE STRIP RUNS ALONG THE FRAME'S LONG AXIS.
A horizontal strip is only ever built from cells with `cellAr >= 1`, so its own
aspect is `n * cellAr >= n`; a vertical one only from `cellAr < 1`, so its
aspect is `cellAr / n < 1/n`. An ordinary un-tiled preview therefore lands
strictly inside `[1/n, n]` — at n=4 that is 0.25..4.0, against a widest real
render of about 2.4:1 and a narrowest of about 0.42:1. `read_strip` is that
comparison and nothing more.

The detection has to hold for previews this pack never touched, which is most
of them: `JobPreview` renders for every running job, and a Krea 2 still or a
Wan clip goes through core's own previewer as one frame.
"""
import collections

# Cells per strip. 4 samples a 13s block about every 3.4s — enough to read the
# movement, few enough that the sheet stays one small JPEG. Raising it costs
# per-cell resolution (see `cell_px`), not bandwidth or VRAM.
FRAMES = 4
# Long side of the WHOLE sheet. Sized against ComfyUI's own `--preview-size`
# (bootstrap sets 1024): core does `ImageOps.contain(image, (preview_size,)*2)`
# on the way out, so a sheet above that is silently downscaled and the cells
# get soft. Below it, contain is a no-op and these dimensions survive exactly,
# which is what `read_strip` depends on.
SHEET_PX = 1024
# Per-cell ceiling, so the strip decodes the same TOTAL pixel count the single
# frame did (4 x 256px cells against one 512px frame) and a strip of one — the
# image path, or FRAMES=1 — is byte-for-byte the old behaviour.
CELL_PX_CAP = 512
# Slack on the aspect comparison. `ImageOps.contain` rounds to whole pixels and
# a square-celled strip sits exactly on the boundary, so the threshold is moved
# in rather than left on it. The gap to a real render is enormous either way.
DETECT_SLACK = 0.9

StripPlan = collections.namedtuple("StripPlan", "indices cell_px horizontal")


def strip_plan(t, latent_w, latent_h, *,
               frames=FRAMES, sheet_px=SHEET_PX, cell_cap=CELL_PX_CAP):
    """Which temporal indices to decode, at what size, along which axis.

    `t` is the latent's temporal length — H3 declares `temporal_downscale_ratio
    = 4`, so a 328-frame block carries 82 of them and the whole shot is present
    in `x0` at every sampler step.

    ALWAYS EXACTLY `frames` CELLS once it strips at all, repeating indices when
    `t` is short: the browser's cell count is a constant, so a sheet that
    quietly carried three cells would be cropped as though it had four. The one
    escape is `t < 2` — the H3 image path is T=1 and must stay a plain frame,
    not four copies of one.
    """
    n = max(1, int(frames))
    if t < 2:
        n = 1
    horizontal = latent_w >= latent_h
    if n == 1:
        return StripPlan((0,), max(1, min(cell_cap, sheet_px)), horizontal)
    idx = tuple(round(i * (t - 1) / (n - 1)) for i in range(n))
    return StripPlan(idx, max(1, min(cell_cap, sheet_px // n)), horizontal)


def cell_latent(latent_w, latent_h, cell_px, upscale):
    """The latent size to decode so a cell's long side lands on `cell_px`.

    ROUNDS each dimension, which is why `_decode` passes `interpolate(size=)`
    rather than `scale_factor=` — the latter floors, and these latents are
    coarse enough for that to be a real distortion rather than a pixel: a
    1376x768 render is an 86x48 latent, and at a 256px cell budget the height
    truncates 8.93 to 8. That previews the shot at 2.00:1 against its true
    1.79:1, and the browser reads the box's shape off the cell, so the
    squashing is visible in the queue as well as in the picture.
    """
    scale = min(1.0, cell_px / max(1, max(latent_w, latent_h) * upscale))
    if scale >= 1.0:
        return latent_w, latent_h
    return max(1, round(latent_w * scale)), max(1, round(latent_h * scale))


def read_strip(sheet_w, sheet_h, *, frames=FRAMES, slack=DETECT_SLACK):
    """(cols, rows) for a published sheet, from its pixel size alone.

    `(1, 1)` means an ordinary single-frame preview — including every preview
    from a model this pack does not hook. See the module docstring for why the
    aspect ratio is sufficient.
    """
    n = max(1, int(frames))
    if n < 2 or sheet_w <= 0 or sheet_h <= 0:
        return (1, 1)
    ar = sheet_w / sheet_h
    if ar >= n * slack:
        return (n, 1)
    if ar <= 1.0 / (n * slack):
        return (1, n)
    return (1, 1)

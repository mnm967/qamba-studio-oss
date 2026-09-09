#!/usr/bin/env python3
"""Generate the model catalogue this build bundles.

The single source of truth for the model pickers, the frame grids and the
worker's own graph resolution. Local rows DERIVE from
`infra/model_map.full.json` — a row's `local_files` fragment is exactly what
`worker/resolve.py` consumes — so a model cannot be offered under a name the
renderer will not resolve.

IT USED TO BE A DATABASE TABLE. The cloud build upserted these rows into
Postgres and every browser fetched them, which meant a control stayed
invisible until somebody remembered to run this script against production.
Here the catalogue is a fact about the BUILD, so it is generated into a
TypeScript module and imported: `src/lib/modelCatalog.gen.ts`, read through
`src/lib/catalog.ts`.

The three guards survive the move, because each of their failures is silent: a
catalog id that mistranslates to its model_map key ships a picker whose payload
the worker cannot resolve; a LoRA key the entry does not declare is dropped by
the worker with a log line nobody reads; and two rows of one kind sharing a
`sort` list in an order nothing decides.

    python3 scripts/gen_model_catalog.py            # write + report
    python3 scripts/gen_model_catalog.py --check    # report only, exit 1 on drift
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "src", "lib", "modelCatalog.gen.ts")

with open(os.path.join(ROOT, "infra", "model_map.full.json")) as f:
    AWS = json.load(f)["full"]

# The three aspect grids the UI offers, per size tier (pixel budgets match
# src/lib/models.js; H3 dims snap to 32 in resolve).
SIZES = [
    {"id": "480p", "label": "480p", "dims": {"16:9": [832, 480], "9:16": [480, 832], "1:1": [640, 640]}},
    # 720p is NOT 720 pixels tall here, and that is the point. 720 is illegal on
    # every `dim_step` 32 model, so it was rounded — and 720/32 is exactly 22.5,
    # the one boundary where the browser's `Math.round` (736) and the worker's
    # ties-to-even `round` (704) disagree. A render that named its size got 736
    # and one that let `handle_clip_gen` default got 704, so a chain came back
    # 16px shorter than the blocks either side of it and the timeline padded the
    # difference in as black bars. 736 is legal at step 32, it is in
    # H3_NATIVE_DIMS (so H3 does not rescale it internally), and it is what
    # H3_IMAGE_SIZES below already uses for 16:9.
    {"id": "720p", "label": "720p", "dims": {"16:9": [1280, 736], "9:16": [736, 1280], "1:1": [960, 960]}},
    {"id": "1080p", "label": "1080p", "maxFrames": 81,
     "dims": {"16:9": [1920, 1088], "9:16": [1088, 1920], "1:1": [1440, 1440]}},
]
#: A model that runs on the machine in front of you costs electricity, which
#: this build does not try to put a number on. The shape is kept so a picker
#: written against `pricing` still has something to read.
GPU_PRICING = {"note": "runs on this machine"}

rows = []

def row(id, family, display_name, kind, provider, **kw):
    r = {"id": id, "family": family, "display_name": display_name, "kind": kind,
         "provider": provider, "modes": [], "pricing": {}, "capabilities": {},
         "enabled": True, "sort": 100}
    r.update(kw)
    # `refine` is DERIVED from model_map, never hand-written per row — the same
    # rule `defaultNegative` follows, and for the same reason: refinement is
    # orthogonal to what distinguishes these rows, so it is declared once on
    # each entry and six hand-copied `"refine": True`s would drift the day a
    # seventh H3 row lands. A picker toggle that is offered where resolve()
    # would raise is worse than no toggle.
    if (r.get("local_files") or {}).get("refine"):
        r["capabilities"]["refine"] = True
    # Same rule for the OTHER second pass. They are alternatives — resolve()
    # refuses both at once — so a surface offering these must offer them as a
    # choice, not two checkboxes.
    if (r.get("local_files") or {}).get("split_pass"):
        r["capabilities"]["splitPass"] = True
    # The THIRD second pass (resolve._splice_h3_latent_upscale): a learned
    # latent resize between a small first pass and a short full-size tail.
    # The only one PDD can run — the other two invent sigmas off its grid.
    if (r.get("local_files") or {}).get("latent_upscale"):
        r["capabilities"]["latentUpscale"] = True
    rows.append(r)

# The video side stacks adapters now too (model_map's `style_loras` on the H3
# entries + resolve.lora_stack), so a concept LoRA is a PICK on H3 rather than
# a checkpoint variant of its own — they combine, which is the whole point of a
# concept LoRA, and four of them would otherwise have meant eight near-identical
# rows in this picker. A style variant that really does replace the checkpoint
# still gets its own model_map entry rather than a pick here.
#
# What does NOT happen here, unlike images: no trigger is ever prepended. An H3
# prompt is the compiled three-field envelope (invariant #6) and pasting a bare
# sentence in front of it corrupts the format the model reads, so each author's
# phrasing lives in the hint and belongs inside the shot description.
# `partial` = ComfyUI cannot reshape some of this adapter's tensors onto H3 and
# skips them. The render SUCCEEDS and the rest of the LoRA applies — but it logs
# one `ERROR lora …` line per skipped tensor, which reads like a failed job and,
# worse, buries a real LoRA error in the noise. Measured off the safetensors
# headers (lora_A input width vs the base layer's) and confirmed on a live
# render: a clip stacking two such adapters logged exactly 100 errors, all
# adaln_proj, 50 from each, and nothing else — then finished clean.
ADALN_PARTIAL = ("Part of this adapter (its 50 AdaLN modulation tensors) does "
                 "not fit H3's layout and is skipped; the 400 attention/MLP "
                 "tensors apply, so the style still lands and the render "
                 "completes.")
H3_LORAS = [
    # The SECOND craft adapter (2026-09-01): Jojocodex's Camera Motion LoRA,
    # cinematography the base model is weakest at. Header-probed like every
    # H3 adapter here — 416 tensors, rank 16 F16, diffusers naming, NO
    # adaln_proj (the author pruned them and says so in the metadata), widths
    # matching H3's real layout — the clean profile: applies whole, logs
    # nothing. Its trigger `camera motion` is PLACED at the head of the
    # compiled description (model_map `lora_triggers`);
    # `handlers.blocks` adds it to any block whose shots move the camera
    # (`params.camera_motion`, stamped at plan time like `fight`).
    {"key": "camera", "label": "Camera Motion", "strength": 0.9,
     "trigger": "camera motion",
     "hint": "Adds the moves H3 is weakest at. Strong: push-in / dolly in, "
             "pull-back / dolly out, handheld tracking. Good: orbit, aerial "
             "drone, crane / tilt, push-in-then-pull-back, macro. Weak: pan "
             "(sparse data — pair it with another move). Say the move in "
             "the shot prose ('slow push-in', 'dynamic handheld following the "
             "action'); the trigger is placed for you. Author: 0.8 gentle, "
             "1.0 pronounced, above 1.2 the picture destabilises. Trained on "
             "fl2va (Comfy-Org build); r2v is outside the author's tests, as "
             "combat's was. Applied automatically to blocks whose camera "
             "lines move."},
    # Header-probed at 416 tensors,
    # diffusers naming, rank 16, no adaln_proj: the clean profile, applies
    # whole, logs nothing. Not `partial`.
    #
    # NO `trigger` KEY, DELIBERATELY. This adapter's triggers are GRADUATED —
    # the author says to start with none ("No Trigger for maximum anatomical
    # accuracy"), rising to `prfight2` and then `prfight2, prfin1`.
    # A token placed at the head of every render would pin the intensity to one
    # rung and take the choice away from the shot — so the escalation is
    # written into the description, which is where the author puts it too.
    {"key": "combat", "label": "Combat Base V2",
     "hint": "Fight choreography, impact and stunt physics: strikes carry "
             "momentum when they miss, hit reactions persist and accumulate, "
             "and falls have real trajectories. Also lifts DIALOGUE scenes "
             "(author measures +19.5% in-shot motion, +34.2% audio RMS). It "
             "does NOT choreograph for you — say who strikes first, where it "
             "lands, how the other reacts and why the next move follows. "
             "Escalate by writing the tokens into the shot: none (steadiest "
             "anatomy) -> 'prfight2' (higher intensity) -> 'prfight2, prfin1' "
             "(heavy finisher). Those are V2's tokens — the lower half of the "
             "model page still describes V1 and names prfight1/prslow1, which "
             "this file was not trained on. In a shot with both, finish the "
             "action before the dialogue or motion reverts to the base "
             "model's slower feel. Author tested FL2VA only (i2v/t2v/flf), so "
             "r2v is out of distribution, and warns that HIGH weights cost "
             "H3's own fluidity — sped-up motion, blur, attacks that never "
             "recover. SAMPLER MATTERS MORE HERE THAN ANYWHERE ELSE: the "
             "author says to check it first when the LoRA looks muddy, and "
             "names res_multistep+simple or euler+beta. Plain MiniMax H3 "
             "already ships the first of those; every TURBO row replaces the "
             "sampler outright with the distillation's own at 6 steps, which "
             "is neither. On a turbo row this adapter has come back with "
             "ghosting; its motion and sharpness gains were measured on plain "
             "H3, not on turbo."},
]
# A pick is not necessarily a FILE — an adapter published as a pair splices
# twice — so the real ceiling is the MODEL chain and VRAM rather than this
# number, which is only what the picker will let you choose at once.
H3_MAX_LORAS = 4

# --- local video (files from model_map) ------------------------------------
# The H3 video family occupies sort 9-12, in this order: turbo, base, PDD,
# lightx2v. PDD and lightx2v
# were each ADDED AT a number another row already held (10 and 11), and
# `catalog.ts` orders on `sort` alone with no tiebreak — so each of those pairs
# came back in whatever order the query plan produced. Fixed by shifting the
# incumbents down, which is what the image block's own comment already
# describes doing. A new row here takes 16, or takes its slot and shifts
# everything below it; it does not share one.
mm = AWS["models"]
row("h3-local", "minimax-h3", "MiniMax H3 (local)", "video", "local",
    modes=list(mm["minimax-h3"]["modes"].keys()), sizes=SIZES, max_seconds=15,
    fps=24, frame_base=17, frame_rem=5, dim_step=32, pricing=GPU_PRICING,
    capabilities={"audio": True, "multiRef": 9, "refVideos": 3, "refAudios": 3,
                  "flf": True, "videoEdit": True, "attribution": "MiniMax H3",
                  "styleLoras": H3_LORAS, "maxLoras": H3_MAX_LORAS},
    local_files=mm["minimax-h3"], sort=10)
# Turbo = the same checkpoints with a step-distillation LoRA and its own
# sampler (Larryvrh/ComfyUI-MiniMax-H3-Turbo), 20 steps -> 6. Orthogonal to
# style, hence the pairing: every style variant can have a turbo twin, and
# each twin is a model_map entry + a row here and nothing else.
TURBO_NOTE = ("Step-distilled: 6 steps instead of 20. Needs the "
              "MiniMaxH3TurboSampler node. Author's guidance is 6-8 steps; "
              "below 6 fast motion can smear.")
row("h3-turbo-local", "minimax-h3", "MiniMax H3 · Turbo", "video", "local",
    modes=list(mm["minimax-h3-turbo"]["modes"].keys()), sizes=SIZES,
    max_seconds=15, fps=24, frame_base=17, frame_rem=5, dim_step=32,
    pricing=GPU_PRICING,
    capabilities={"audio": True, "multiRef": 9, "refVideos": 3, "refAudios": 3,
                  "flf": True, "videoEdit": True, "attribution": "MiniMax H3",
                  "turbo": True, "note": TURBO_NOTE,
                  "styleLoras": H3_LORAS, "maxLoras": H3_MAX_LORAS},
    local_files=mm["minimax-h3-turbo"], sort=9)
# The OFFICIAL 8-step distillation (alibaba-pai, Parallel Decoding
# Distillation) — not an ordinary LoRA: a trunk LoRA plus a per-interval head
# bank its own Apply node loads, emitting the trained sigmas (euler, cfg 1).
# Two things earn it a row beside Turbo: it applies WHOLE on our pruned int8
# checkpoints (zero `ERROR lora` where every other adaln-carrying adapter
# spams 50), and it has a ref2va build — so EPISODE blocks (r2v) run it,
# which the lightx2v row below cannot. A/B'd against Turbo on one block:
# same speed, cleaner frames (no cross-dissolve ghosting); a quoted line's
# tail slurred slightly worse on one take. Distills don't stack (resolve
# refuses pdd beside turbo_lora); style/concept LoRAs stack normally.
row("h3-pdd-local", "minimax-h3", "MiniMax H3 · PDD 8-step", "video", "local",
    modes=list(mm["minimax-h3-pdd"]["modes"].keys()), sizes=SIZES,
    max_seconds=15, fps=24, frame_base=17, frame_rem=5, dim_step=32,
    pricing=GPU_PRICING,
    capabilities={"audio": True, "multiRef": 9, "refVideos": 3, "refAudios": 3,
                  "flf": True, "videoEdit": True, "attribution": "MiniMax H3",
                  "turbo": True,
                  "note": "The official alibaba-pai 8-step distill. Turbo "
                          "speed with cleaner frames side by side (no "
                          "ghosting), and it has a reference-mode build, so "
                          "episodes use it end to end. Sampler and schedule "
                          "are fixed by the distill (euler, 8 steps).",
                  "styleLoras": H3_LORAS, "maxLoras": H3_MAX_LORAS},
    local_files=mm["minimax-h3-pdd"], sort=11)
# A SECOND distillation, from the other team doing this (ModelTC/lightx2v), and
# the interesting difference is not the step count — it is that this one applies
# through a plain LoraLoaderModelOnly, so it depends on no custom node at all
# where the row above dies without the Larryvrh pack. That makes it the safer
# entry on a fresh box; what it is not is measured, unlike the 2.7x above.
row("h3-lightx2v-local", "minimax-h3", "MiniMax H3 · Turbo (lightx2v)",
    "video", "local", modes=list(mm["minimax-h3-lightx2v"]["modes"].keys()),
    sizes=SIZES, max_seconds=15, fps=24, frame_base=17, frame_rem=5,
    dim_step=32, pricing=GPU_PRICING,
    capabilities={"audio": True, "flf": True, "videoEdit": True,
                  "attribution": "MiniMax H3", "turbo": True,
                  "styleLoras": H3_LORAS, "maxLoras": H3_MAX_LORAS,
                  "note": "Step-distilled to 4 (vendor: strength 0.75, sampler "
                          "er_sde). Needs no custom node, unlike the other "
                          "turbo row. fl2va only — no reference mode. The "
                          "vendor notes ComfyUI and Diffusers differ here on "
                          "AUDIO quality, so check the sound before trusting a "
                          "dialogue block to it."},
    local_files=mm["minimax-h3-lightx2v"], sort=12)
row("wan22-local", "wan2.2", "Wan 2.2 14B", "video", "local",
    modes=list(mm["wan2.2"]["modes"].keys()),
    sizes=[s for s in SIZES if s["id"] != "1080p"], max_seconds=8, fps=16,
    pricing=GPU_PRICING, local_files=mm["wan2.2"], sort=30)
row("wan-shinkai-local", "wan2.2", "Wan Shinkai", "video", "local",
    modes=["i2v"], sizes=SIZES[:1], max_seconds=8, fps=16,
    pricing=GPU_PRICING, local_files=mm["wan-shinkai"], sort=31)
row("animegen-local", "wan2.2", "AnimeGen", "video", "local",
    modes=["i2v"], sizes=SIZES[:1], max_seconds=8, fps=16,
    pricing=GPU_PRICING, local_files=mm["animegen"], sort=32)
row("ltx-ttgl-local", "ltx-2.3", "LTX 2.3 · TTGL", "video", "local",
    modes=["i2v"], sizes=[s for s in SIZES if s["id"] != "1080p"], max_seconds=10,
    fps=24, pricing=GPU_PRICING, local_files=mm["ltx-ttgl"], sort=40)
row("ltx-env-local", "ltx-2.3", "LTX 2.3 · Shinkai env", "video", "local",
    modes=["i2v"], sizes=[s for s in SIZES if s["id"] != "1080p"], max_seconds=10,
    fps=24, pricing=GPU_PRICING, local_files=mm["ltx-env"], sort=41)
# LTX 2.5: NATIVE AUDIO like H3 (the only other local family that has it),
# two-pass official pipeline (base at half res -> latent 2x upsample ->
# 4-sigma refine), and an r2v whose references are SLOT-EMBEDDED — four
# subject slots plus a DEDICATED background slot (liconstudio's MSR stack),
# unlike H3's flat nine-picture pool.
#
# VERIFIED LIVE 2026-08-17, 41 frames at 768x448 (8n+1 grid, 24fps): t2v 24s
# and r2v 30s, both returning h264 + AAC 48kHz — i.e. the generated-audio
# branch works on the reference path too, which was the one place this
# deviates from the workflow it was adapted from. The trace confirmed the
# half-res arithmetic (base latent 384x224 upsampling exactly onto 768x448)
# and both distilled schedules (8 steps then 3). The r2v held the location
# from the background slot while composing a NEW camera on it.
row("ltx-25-local", "ltx-2.5", "LTX 2.5 · native audio", "video", "local",
    modes=["t2v", "r2v"], sizes=[s for s in SIZES if s["id"] != "1080p"],
    max_seconds=10, fps=24, pricing=GPU_PRICING,
    capabilities={"audio": True, "multiRef": 4, "backgroundRef": True,
                  "note": "22B distilled int8-convrot, audio generated "
                          "natively. r2v stages up to 4 subject refs plus a "
                          "dedicated background slot (Licon MSR)."},
    local_files=mm["ltx-25"], sort=42)

# --- hosted video -----------------------------------------------------------
#
# WHAT A HOSTED VIDEO ROW HAS TO DECLARE, and why each part is load-bearing.
#
# `modes` is the same vocabulary the local rows use (t2v/i2v/flf/r2v), and it
# is what every picker filters on — `BlockActionModal.MODE_FOR` maps chain->flf
# and extend->i2v, so a row that overstates its modes is a job that dies at the
# provider. A row that UNDERSTATES them is a model the picker never offers.
#
# `local_files` is the "how to call it" fragment (withheld from non-admins by
# `model_catalog_visible`), and for these it carries the ADAPTER plus that
# provider's dialect. Putting the field names here rather than in code is what
# makes the next fal model a catalog insert — the thing `fal_h3.py` set out to
# do and only half managed, because its BODY was fixed even though its endpoint
# was not.
#
# `frame_base` is deliberately ABSENT on every row here: these APIs take
# SECONDS, not frames, so `frameGrid().exact` is false and the duration control
# offers every length and says the pod will round it. Declaring H3's 17n+5 on a
# model that has never heard of it is a number nobody can see is wrong.
#
# ENABLED IS ABOUT THE STUDIO'S KEY, not about whether the adapter works. A
# disabled row still renders for a user who has pasted their own key — the
# picker's `byokRows` forces it back on — so `capabilities.blocked` is what a
# member reads, and it has to say something true and actionable.
_NO_KEY = "the studio has no key for this provider yet — add your own under API keys"

# Seedance takes `duration` as a STRING enum, not a number. A number is a 422
# at submit; the enum is "auto" plus whole seconds.
_SEEDANCE_DUR = ["auto"] + [str(n) for n in range(4, 31)]

H3_CAPS = {"audio": True, "multiRef": 9, "refVideos": 3, "flf": True,
           "attribution": "MiniMax H3", "adapter": "minimax_api"}
row("h3-api-768p", "minimax-h3", "MiniMax H3 API · 768p", "video", "minimax",
    modes=["t2v", "i2v", "flf", "r2v"], max_seconds=15, fps=24,
    pricing={"unit": "second", "usd": 0.09, "estimate": True,
             "note": "official beta price; some sources list $0.08/s; first 5 image refs free then $0.04 ea"},
    capabilities={**H3_CAPS, "blocked": _NO_KEY},
    local_files={"adapter": "minimax_api", "api_model": "MiniMax-H3"},
    enabled=False, sort=20)
row("h3-api-2k", "minimax-h3", "MiniMax H3 API · 2K", "video", "minimax",
    modes=["t2v", "i2v", "flf", "r2v"], max_seconds=15, fps=24,
    pricing={"unit": "second", "usd": 0.13,
             "note": "official 2K price; ~$1.95 per 15s master"},
    capabilities={**H3_CAPS, "blocked": _NO_KEY},
    local_files={"adapter": "minimax_api", "api_model": "MiniMax-H3"},
    enabled=False, sort=21)
row("h3-api-regen2k", "minimax-h3", "H3 Regenerate-2K (mastering)", "video", "minimax",
    modes=["v2v"], max_seconds=15, fps=24,
    pricing={"unit": "second", "usd": 0.05, "estimate": True,
             "note": "in-context 2K regeneration of an H3 output; one source lists $0.10/s"},
    capabilities={"attribution": "MiniMax H3", "adapter": "minimax_api",
                  # The one hosted row with no BROWSER adapter, deliberately:
                  # `v2v` is a mode no picker offers and `minimax_api.py` does
                  # not implement, so a spec in `HOSTED_SPECS` would put a row
                  # in front of someone whose only outcome is a failure.
                  "blocked": "video-to-video is not wired on either plane yet"},
    enabled=False, sort=22)
row("fal-h3-2k", "minimax-h3", "MiniMax H3 via fal · 2K", "video", "fal",
    modes=["t2v", "i2v", "r2v"], max_seconds=15, fps=24,
    pricing={"unit": "second", "usd": 0.26, "estimate": True,
             "note": "$3.90 per 15s — official API is cheaper"},
    capabilities={**H3_CAPS, "adapter": "fal_video", "flf": False,
                  "blocked": _NO_KEY},
    local_files={"adapter": "fal_video", "fal": {
        "endpoints": {"t2v": "fal-ai/minimax/hailuo-3",
                      "i2v": "fal-ai/minimax/hailuo-3",
                      "r2v": "fal-ai/minimax/hailuo-3"},
        "duration": "int", "aspect": False,
        "start": "image_url", "images": "reference_image_urls", "max_refs": 9}},
    enabled=False, sort=23)

# ---- ByteDance Seedance ----------------------------------------------------
#
# THE MODES ARE THREE SEPARATE ENDPOINTS, and they do not share field names —
# which is the whole reason `fal_video.py` replaced `fal_h3.py`. `image-to-video`
# takes `image_url` AND `end_image_url`, so a CHAIN is expressible; the
# `reference-to-video` one takes `image_urls`/`video_urls`/`audio_urls` and no
# start frame at all. Sending one body to the other endpoint drops every
# reference silently — fal ignores an input the endpoint does not declare — and
# returns a perfectly good clip of the wrong thing.
_SEEDANCE_25 = {
    "endpoints": {"t2v": "bytedance/seedance-2.5/text-to-video",
                  # THE i2v ENDPOINT HAS NO REFERENCE LIST. It declares
                  # `image_url` and `end_image_url` and nothing else, so a
                  # model-level `image_urls` written here is dropped by fal and
                  # the extend silently loses the identity sheets staged for
                  # it. Wan 3.0 is the row that can do both at once.
                  "i2v": {"id": "bytedance/seedance-2.5/image-to-video",
                          "images": None, "videos": None, "audios": None},
                  "flf": {"id": "bytedance/seedance-2.5/image-to-video",
                          "images": None, "videos": None, "audios": None},
                  "r2v": "bytedance/seedance-2.5/reference-to-video"},
    "duration": "string", "durations": _SEEDANCE_DUR,
    "resolutions": ["480p", "720p"], "aspect": True,
    "audio_flag": "generate_audio",
    "start": "image_url", "end": "end_image_url",
    "images": "image_urls", "videos": "video_urls", "audios": "audio_urls",
    "max_refs": 50,
}
row("seedance-2.5", "seedance", "Seedance 2.5", "video", "fal",
    modes=["t2v", "i2v", "flf", "r2v"], max_seconds=30, fps=24,
    pricing={"unit": "second", "usd": 0.05, "estimate": True,
             "note": "fal does not publish a flat per-second figure for 2.5 — "
                     "unverified, and only the ledger reads it"},
    capabilities={"audio": True, "multiRef": 50, "refVideos": 50,
                  "refAudios": 50, "flf": True, "adapter": "fal_video",
                  "note": "30s in one pass, up to 50 mixed image/video/audio "
                          "references. The prompt addresses them by position — "
                          "[Image1], [Video1], [Audio1] — so reference ORDER is "
                          "part of the instruction, not a detail.",
                  "blocked": _NO_KEY},
    local_files={"adapter": "fal_video", "fal": _SEEDANCE_25},
    enabled=False, sort=24)
# Seedance 2.0 is still current and much cheaper; kept because "fast" is a real
# pick, not a superseded one. Its own endpoints follow the same dialect.
row("seedance-2-fast", "seedance", "Seedance 2.0 Fast", "video", "fal",
    modes=["t2v", "i2v"], max_seconds=8, fps=24,
    pricing={"unit": "second", "usd": 0.022, "estimate": True, "note": "1080p, no audio"},
    capabilities={"adapter": "fal_video", "blocked": _NO_KEY},
    local_files={"adapter": "fal_video", "fal": {
        "endpoints": {"t2v": "bytedance/seedance-2.0/text-to-video",
                      "i2v": "bytedance/seedance-2.0/image-to-video"},
        "duration": "string", "resolutions": ["480p", "720p", "1080p"],
        "aspect": True, "start": "image_url", "max_refs": 4}},
    enabled=False, sort=60)

# ---- Alibaba Wan 3.0 -------------------------------------------------------
#
# THE ONLY HOSTED ROW THAT COVERS EVERY MODE THIS STUDIO RENDERS. `first_frame`,
# `last_frame`, `reference_image` (<=10), `reference_video` (<=5) and
# `reference_audio` (<=5) are five `input.media[].type` values on ONE endpoint,
# so an extend, a chain and a reference shot are the same request with a
# different media list. Every other hosted video model here does a subset:
# Seedance has no reference video on its i2v endpoint, FLUX 3 publishes t2v
# only, and Omni Flash cannot end on a given frame at all.
#
# 30 seconds in one pass also means a hosted BLOCK is expressible — H3's own
# ceiling is 14.4s — though nothing queues one yet (see `handle_launch_render`).
_WAN3_CAPS = {"audio": True, "multiRef": 10, "refVideos": 5, "refAudios": 5,
              "flf": True, "adapter": "wan_api",
              "note": "first frame, last frame, and mixed image/video/audio "
                      "references on one endpoint — the only hosted row that "
                      "can do a chain, an extend and a reference shot.",
              "blocked": _NO_KEY}
row("wan3-video", "wan3", "Wan 3.0", "video", "alibaba",
    modes=["t2v", "i2v", "flf", "r2v"], max_seconds=30, fps=24,
    pricing={"unit": "second", "usd": 0.10,
             "note": "published API pricing: $0.05/s 480P, $0.10/s 720P, "
                     "$0.20/s 1080P — wan_api books the tier it rendered"},
    capabilities=_WAN3_CAPS,
    local_files={"adapter": "wan_api", "api_model": "wan3.0-video"},
    enabled=False, sort=25)
row("wan3-video-prime", "wan3", "Wan 3.0 Prime (fast)", "video", "alibaba",
    modes=["t2v", "i2v", "flf", "r2v"], max_seconds=30, fps=24,
    pricing={"unit": "second", "usd": 0.10, "estimate": True,
             "note": "the high-speed build; Alibaba does not publish a "
                     "separate rate, so this mirrors the standard one"},
    capabilities=_WAN3_CAPS,
    local_files={"adapter": "wan_api", "api_model": "wan3.0-video-prime"},
    enabled=False, sort=26)

# ---- Black Forest Labs FLUX 3 ---------------------------------------------
#
# t2v ONLY, and that is a documentation fact rather than a model limit. BFL's
# own `/v1/flux-3-video` takes `mode` t2v/i2v/v2v on one endpoint, and the blog
# describes keyframe-to-video (a chain) and video continuation (an extend) —
# but fal publishes the text-to-video schema alone, and the sibling endpoint
# ids are not documented anywhere this could be read from. Declaring i2v on a
# guessed endpoint id is a 404 minutes into a render, so the row claims what is
# confirmed. Add the modes when the ids are.
row("flux-3-video", "flux3", "FLUX 3 Video", "video", "fal",
    modes=["t2v"], max_seconds=20, fps=24,
    pricing={"unit": "second", "usd": 0.08, "estimate": True,
             "note": "fal does not publish a flat per-second figure — unverified"},
    capabilities={"audio": True, "adapter": "fal_video",
                  "note": "20s with native audio. Only text-to-video is "
                          "documented on fal; BFL's own API adds image-to-video "
                          "and video continuation on one endpoint.",
                  "blocked": _NO_KEY},
    local_files={"adapter": "fal_video", "fal": {
        "endpoints": {"t2v": "blackforestlabs/flux-3/text-to-video"},
        "duration": "string",
        "durations": ["auto"] + [str(n) for n in range(5, 21)],
        "resolutions": ["720p", "1080p"], "aspect": True,
        "audio_flag": "generate_audio"}},
    enabled=False, sort=27)

# ---- Google Gemini Omni Flash ---------------------------------------------
#
# The closest hosted analogue to H3's ref2va shape — 7 reference images and 3
# short clips in one generation, audio produced with the picture — on a key
# this studio ALREADY holds for Nano Banana.
#
# IT RIDES THE INTERACTIONS API, which is the surface `gemini_image.py`
# deliberately avoided and said why: its docs "disagree with themselves about
# the auth header and the response path". Video has no `generateContent` form,
# so there is no avoiding it here. `gemini_video.py` is written defensively for
# exactly that (key sent both ways, result found by walking rather than by
# indexing a documented path) and the row stays disabled until it has answered
# once against the live API — which is this repo's rule for a hosted row, not a
# hedge about this one.
row("gemini-omni-flash", "gemini-omni", "Gemini Omni Flash", "video", "google",
    modes=["t2v", "i2v", "r2v"], max_seconds=10, fps=24,
    pricing={"unit": "second", "usd": 0.10,
             "note": "published preview price"},
    capabilities={"audio": True, "multiRef": 7, "refVideos": 3, "flf": False,
                  "adapter": "gemini_video",
                  "note": "7 reference images + 3 short clips, native audio. "
                          "No first-and-last-frame mode, so it cannot serve a "
                          "chain — the closing frame would only be described.",
                  "blocked": "not verified against the live API yet — see "
                             "providers/gemini_video.py"},
    local_files={"adapter": "gemini_video", "model": "gemini-omni-1.1-flash"},
    enabled=False, sort=28)

# --- image models -----------------------------------------------------------
# LoRA entries are OBJECTS, not bare keys: the picker shows several at once with
# per-adapter strength, and it needs a label and a trigger word to say what each
# one does. `key` is the only part that travels in a job payload — the worker
# maps it to a filename through model_map's style_loras, so no .safetensors name
# ever reaches the browser.
LORA = {
    "shinkai": {"key": "shinkai", "label": "Shinkai",
                "hint": "Makoto Shinkai colour, light and cloud rendering."},
    # `strength` is the value the picker STARTS this adapter at. Lenovo is the
    # reason the field exists: its author's range for turbo checkpoints is
    # 1.2-2.0, and every Krea 2 entry here is turbo — seeding it at the shared
    # 1.0 default would have it quietly under-applied on every generation.
    "lenovo": {"key": "lenovo", "label": "UltraReal", "strength": 1.2,
               "hint": "Photographic realism. No trigger word. Author's range: "
                       "0.8 on a raw checkpoint, 1.2-2.0 on turbo (these are turbo)."},
    "identity": {"key": "identity", "label": "Identity Edit",
                 "hint": "Identity-preserving instruction edits (v1.2): restage or "
                         "redress a person while keeping the face. The outfit-variant "
                         "path uses it automatically; strength 1.0, turbo 8-12 steps."},
    "realism": {"key": "realism", "label": "Realism Engine",
                "hint": "v3.1, 1.5GB — broad concept knowledge and photographic "
                        "realism. No trigger word."},
}
K2_LORAS = [LORA["lenovo"], LORA["identity"], LORA["realism"]]
# Krea2EditRebalance conditions on image1..image4 — four is the node's ceiling,
# not ours, so the picker must stop offering slots at four.
K2_CAPS = {"styleLoras": K2_LORAS, "multiRef": 4, "refs": 4,
           "edit": True, "maxLoras": 5, "refNode": "Krea2EditRebalance",
           # The identity-edit path (graphs.krea2_identity_graph): a
           # one-character composition — a storyboard panel, a still — runs
           # the Identity Edit LoRA the way it was trained, with the sheet as
           # in-context latent tokens and an image-grounded encode, instead of
           # the Rebalance conditioning. Automatic where the pack is installed;
           # `payload.identity_edit` forces it either way.
           "identityEdit": True}

im = AWS["image_models"]
for mid, fam, name, files, caps, sort in [
    # The three MiniMax H3 · image rows are 52/53/54 and want to stay
    # contiguous; Klein sits directly under them and has been shifted down
    # once per row added above it — 53 when H3 turbo landed, then 55 when H3
    # PDD took 54. That second shift was overdue: PDD was added AT 54 while
    # Klein was still there, and `catalog.ts` orders on `sort` alone with no
    # tiebreak, so for as long as they collided those two rows came back in
    # whatever order the plan happened to produce. Keep every sort here
    # distinct.
    # Flux.1-dev (+Shinkai) at 55 and plain Flux 2 GGUF at 56 were removed from
    # the picker 2026-09-06. Their model_map entries, graph builders and the
    # `flux`/`flux2` reference fallbacks are untouched — only the catalog rows
    # went — so re-listing one is a tuple here plus a re-sync. NOTE the sync
    # only ever UPSERTS: a row deleted here stays in `model_catalog`, and in
    # every picker, until it is DELETEd from the table as well.
    # Klein's Shinkai LoRA used to be a bare `lora` in model_map, applied to
    # every generation at strength 1.0 with "anime screencap" forced into the
    # prompt — invisible here and impossible to switch off, which mattered
    # because Klein is also the automatic fallback for reference jobs. It is now
    # an ordinary key, so base Klein is reachable and the anime look is opt-in.
    ("klein-local", "flux2", "Flux 2 Klein 9B", im["klein"],
     {"multiRef": 6, "refs": 6, "edit": True, "maxLoras": 3,
      "styleLoras": [
          {"key": "shinkai", "label": "Shinkai", "trigger": "anime screencap",
           "hint": "Anime-screencap look, Klein 9B build. Was forced on every "
                   "Klein render before; now opt-in."}]}, 55),
    # THE 4B IS A SEPARATE ENTRY FROM THE 9B ABOVE, not a rung of it, because
    # the two share neither a checkpoint nor an ENCODER: 9B reads Qwen3-8B
    # fp8mixed and 4B reads Qwen3-4B fp4. It is also the only Black Forest Labs
    # model here under Apache 2.0 rather than a non-commercial licence, which
    # is why `engineCatalog` splits them too.
    #
    # NO `styleLoras`. Klein's own adapter is a 9B build, and a 9B LoRA on a
    # 4B model is the silent partial-apply this file keeps naming — it loads,
    # logs nothing and lands on the wrong widths.
    #
    # `family` is `flux2`, not `klein`: Klein IS Flux 2 architecturally (core
    # detects it as `image_model = "flux2"` off its own state dict), so
    # `flux2_ref_graph` renders it — which is what gives it references, and
    # what makes the DESKTOP able to draw a reference sheet with it through
    # the bundled Python. `max_refs` on the map entry is what actually turns
    # those on (`handlers/images._refs` diverts a family with no `max_refs` to
    # Qwen-Edit); this row's `refs` is only what the picker says.
    #
    # sort 58 rather than 56 — beside the 9B at 55 would mean shifting Anima,
    # and the note above records that shifting these has already collided
    # twice. Distinct beats adjacent.
    ("flux2-klein-4b-local", "flux2", "Flux 2 Klein 4B", im["flux2-klein-4b"],
     {"refs": 4, "multiRef": 4,
      "note": "4 steps, Apache 2.0, ~4GB of weights — the reference model a "
              "laptop can hold"}, 58),
    ("krea2-local", "krea2", "Krea 2 Turbo", im["krea2"], K2_CAPS, 50),
    ]:
    # r2i = "references -> image": the Krea2EditRebalance / Flux2 ReferenceLatent
    # path, a SET of reference images composed into a new frame. Distinct from
    # `edit`, which reworks one supplied image (Flux.1 Kontext). Listing only
    # `edit` meant the multi-reference path had no name anywhere in the UI.
    # `noEdit` means it: plain Flux 2 (removed above) had no reference path of
    # any kind, and listing `edit` for it put a mode in the picker whose
    # references the worker staged and then rendered without — a silent
    # downgrade with no error. No row declares it today; the guard stays,
    # because the next t2i-only finetune would reintroduce exactly that bug.
    modes = ["t2i"]
    if caps.get("refs"):
        modes.append("r2i")
    if caps.get("edit") and not caps.get("noEdit"):
        modes.append("edit")
    row(mid, fam, name, "image", "local", modes=modes,
        pricing=GPU_PRICING, capabilities=caps, local_files=files, sort=sort)
# Qwen-Image-Edit 2509 — the reference model, and the fallback any job with
# references lands on. Three images (TextEncodeQwenImageEditPlus's ceiling), and
# that node is ComfyUI core, so unlike the Krea 2 reference path this one cannot
# be missing its dependency.
# 2511, not 2509 — the map's unet moved and this label did not, so the picker
# named a version it had stopped rendering on.
row("qwen-edit-local", "qwen", "Qwen-Image-Edit 2511", "image", "local",
    modes=["t2i", "r2i", "edit"], pricing=GPU_PRICING,
    capabilities={"refs": 3, "multiRef": 3, "edit": True,
                  "note": "reference-driven editing; strong text rendering"},
    local_files=im["qwen-edit"], sort=49)

# SenseNova U1.5 — a UNIFIED multimodal model (generation + editing +
# understanding in one 18B checkpoint), not a diffusion model with a text
# encoder bolted on. It matters here for three things nothing else local does
# as well, each measured on this studio's own THE LAST SERVICE beats rather
# than taken from the model card:
#
#   * It OBEYS A WRITTEN CAMERA over a staged plate. The panel case H3 fails —
#     "reposition the camera, shoot a wide, figures small" beside a location
#     master — came back on H3 as the master's own frontal composition and on
#     this as a genuine wide from across the street with the figure small in
#     frame. That is the whole reason storyboard panels keep needing a better
#     model.
#   * It HOLDS A CAST CLOSE. The solo over-the-shoulder that H3 answered with
#     an invented second face — despite the compiled envelope's terminal "no
#     other person … appears" — came back here with one face in frame and the
#     foreground shoulder as an out-of-focus edge, which is exactly what
#     image_prompt.solo_framing asks for.
#   * It RENDERS LEGIBLE TEXT, so a panel whose signage came back as invented
#     lettering can be corrected by an edit instead of a re-plan.
#
# TEN references, the joint-highest here. Its own guide asks for natural
# language naming each image's ROLE plus an explicit keep/change list, which is
# what image_prompt's "prose" shape produces — see SHAPES.
#
# NO styleLoras: the pack exposes a LoRA input and no SenseNova adapter is
# installed, and a picker key with no file behind it is a control that cannot
# reach the render. NO negativePrompt: neither node has a negative input at all
# — guidance is `cfg_scale` plus, on the reference path, `img_cfg_scale`.
row("sensenova-u1-local", "sensenova", "SenseNova U1.5 8B", "image", "local",
    modes=["t2i", "r2i", "edit"], pricing=GPU_PRICING,
    capabilities={"refs": 10, "multiRef": 10, "edit": True,
                  "note": "unified multimodal model — obeys written camera "
                          "direction over a staged plate, holds a closed cast, "
                          "renders legible text; generates natively at ~4MP, "
                          "so a smaller request is snapped up and downscaled"},
    local_files=im["sensenova-u1"], sort=48)


# Hikari Anima — an ANIME illustration model, and a base family of its own
# rather than an SDXL finetune: 4GB bf16 UNET, Qwen3-0.6B-base text encoder,
# the qwen image VAE the Krea 2 set already fetches. Stock ComfyUI loaders.
#
# It is the only local image model here that is NOT distilled: 30 steps at
# cfg 4.0, which means the negative branch is actually evaluated and a real
# negative prompt does something (every Krea 2 entry runs cfg 1.0 and feeds a
# ConditioningZeroOut). t2i only — Anima's ControlNet-LLLite / inpainting stack
# is not installed, so a job with references routes to Qwen-Edit instead of
# rendering a text-to-image over them.
#
# `defaultNegative` is READ OUT OF THE MAP, never retyped: it is what the worker
# actually applies when a job carries no `negative` of its own, and the browser
# cannot see model_map (`local_files` is withheld from non-admins). The
# composer's field shows it as the placeholder so an empty box reads as "this
# string is being applied" rather than "no negative prompt" — two very different
# claims. Copying it by hand would let the two drift apart silently.
row("hikari-anima-local", "anima", "Hikari Anima 1.0", "image", "local",
    modes=["t2i"], pricing=GPU_PRICING,
    capabilities={"noEdit": True, "negativePrompt": True, "maxLoras": 3,
                  "defaultNegative": im["hikari-anima"]["negative"]},
    local_files=im["hikari-anima"], sort=56)

# Anima-2.9B — the same family DEEPENED rather than finetuned: v1's 28
# transformer blocks deep-copied out to 40 (LLaMA-Pro block expansion, zeroed
# output projections, so it starts functionally identical to base), then trained
# on 1.7M anime/illustration samples to a July 2026 knowledge cutoff. Same
# Qwen3-0.6B encoder, same qwen image VAE, same stock loaders — so it is a
# model_map entry and this row, no code.
#
# NO styleLoras, and that absence is deliberate: `gaping` is trained on the
# 28-block v1, whose block indices ALL exist in the 40-block model, so ComfyUI
# would apply it cleanly onto the wrong layers and log nothing. A v1 adapter
# needs its block indices remapped through the author's expand_manifest before
# it can be declared here.
row("anima-29b-local", "anima", "Anima 2.9B", "image", "local",
    modes=["t2i"], pricing=GPU_PRICING,
    capabilities={"noEdit": True, "negativePrompt": True, "maxLoras": 3,
                  "defaultNegative": im["anima-29b"]["negative"],
                  "note": "Anime illustration, danbooru/gelbooru tags plus "
                          "@artist tags and year tags; name a character WITH "
                          "its series or the model confuses it. Knowledge "
                          "cutoff July 2026. Quality/score tags are optional — "
                          "not trained on. THE MORE DETAILED THE PROMPT THE "
                          "BETTER: a short prompt gets a bland empty "
                          "background. 32 steps at cfg 4.0 here; the author's "
                          "band is 28-50 steps at cfg 3.5-5 and calls 50 the "
                          "highest quality. Non-commercial licence."},
    local_files=im["anima-29b"], sort=57)

# MiniMax H3 as an IMAGE model: one frame out of the video model. ref2va
# conditions on up to nine references, which is more than any other local image
# model here, and it is the same checkpoint the r2v video path already uses — so
# the weights cost nothing extra on disk. Sizes are H3's own native frame list;
# anything else is rescaled by the model.
H3_IMAGE_SIZES = [
    {"id": "1mp", "label": "1MP",
     "dims": {"16:9": [1280, 736], "9:16": [736, 1280], "1:1": [1024, 1024]}},
    {"id": "2mp", "label": "2MP",
     "dims": {"16:9": [1920, 1088], "9:16": [1088, 1920], "1:1": [1376, 1376]}},
]
# One adapter today, and it is checkpoint-specific in a way the picker cannot
# express: `style_loras` is a flat key->file map with no mode dimension, while
# this builder swaps ref2va in for fl2va the moment a job carries references.
# So the constraint goes in the hint, where the user reads it.
H3_IMAGE_LORAS = [
    {"key": "thisisfine", "label": "ThisIsFine (detail)",
     "hint": "Detail/texture lift for the REFERENCE path — trained on ref2va "
             "(the checkpoint a job with references runs on). No trigger. "
             "On plain text-to-image, which runs fl2va, it is out of "
             "distribution: expect less from it there."},
]
row("h3-image-local", "minimax-h3", "MiniMax H3 · image", "image", "local",
    modes=["t2i", "r2i", "edit"], pricing=GPU_PRICING, sizes=H3_IMAGE_SIZES,
    capabilities={"refs": 9, "multiRef": 9, "edit": True, "maxLoras": 2,
                  "attribution": "MiniMax H3", "styleLoras": H3_IMAGE_LORAS,
                  "note": "one frame of the video model; nine reference images "
                          "— more than any other local model. 20 steps, so it "
                          "is the slow one; the turbo row is the same model at "
                          "4-8 steps."},
    local_files=im["h3-image"], sort=52)

# The step-distilled twin, and a separate ROW rather than a toggle for the same
# reason every H3 video variant is: a distillation replaces the sampling recipe
# (sampler, scheduler and step count together), which is not a thing a job can
# carry alongside a checkpoint pick. It is also two different adapters — fl2v
# 8-step for t2i/edit, ref2v 4-step for the reference path — chosen by the same
# mode logic that already chooses the checkpoint, so neither is ever applied to
# weights it was not distilled from.
row("h3-image-turbo-local", "minimax-h3", "MiniMax H3 · image (turbo)",
    "image", "local",
    modes=["t2i", "r2i", "edit"], pricing=GPU_PRICING, sizes=H3_IMAGE_SIZES,
    capabilities={"refs": 9, "multiRef": 9, "edit": True, "maxLoras": 2,
                  "attribution": "MiniMax H3", "styleLoras": H3_IMAGE_LORAS,
                  "note": "lightx2v step distillation: 8 steps for text-to-image "
                          "and single-image edits, 4 for the reference path. "
                          "Try this first; fall back to the plain row if a "
                          "render comes out flat."},
    local_files=im["h3-image-turbo"], sort=53)

# The OFFICIAL distillation, and the third apply shape rather than a third
# adapter. `pdd` is alibaba-pai's Parallel Decoding Distillation: beside a
# rank-64 trunk LoRA these files carry a per-interval HEAD BANK for
# `final_layer` that a plain loader silently drops, so it needs its own node —
# and that node is what makes it the distillation that survives our PRUNED
# int8_convrot checkpoints WHOLE. Every other adaln-carrying adapter here
# spams ~50 `ERROR lora … adaln_proj` lines and loses that part of itself;
# this one rebases those modules and logs nothing.
#
# It is a separate row for the reason turbo is, plus one of its own: the node
# emits the TRAINED BLOCK BOUNDARIES as sigmas, so the schedule and the
# sampler are the distillation's rather than the row's, and more steps is not
# closer to the teacher.
row("h3-image-pdd-local", "minimax-h3", "MiniMax H3 · image (PDD)",
    "image", "local",
    modes=["t2i", "r2i", "edit"], pricing=GPU_PRICING, sizes=H3_IMAGE_SIZES,
    capabilities={"refs": 9, "multiRef": 9, "edit": True, "maxLoras": 2,
                  "attribution": "MiniMax H3", "styleLoras": H3_IMAGE_LORAS,
                  "note": "the official 8-step distillation, and the one that "
                          "applies to our pruned weights without dropping its "
                          "adaln modules. Same 8 steps whichever path a job "
                          "takes, unlike the turbo row's 8/4 split. Only 4, 6 "
                          "or 8 are legal — the step count is the trained "
                          "grid, not a quality dial."},
    local_files=im["h3-image-pdd"], sort=54)

row("gpt-image-1.5", "openai", "GPT Image 1.5", "image", "openai",
    modes=["t2i", "edit"],
    pricing={"unit": "image", "usd": 0.07, "estimate": True,
             "note": "quality-dependent; multi-image edit blends references"},
    # This row shipped WITHOUT local_files, and openai_image.py's fallback
    # chain then rendered it as gpt-image-2 — the picker said 1.5, the render
    # was 2, silently. director/hostedImage.js::HOSTED_MODELS carries the same
    # pair and its test pins the two against each other.
    capabilities={"multiRef": 10, "edit": True},
    local_files={"model": "gpt-image-1.5"}, sort=60)
# The one thing no LOCAL model can do: add a named object to an existing plate
# and leave the rest of it alone. Measured on Kanmuri Street — qwen-edit added
# nothing (its graph has no source latent), krea2 at 0.60 added the sign and
# rewrote the street, at 0.75 it rendered a different street; gpt-image-2 put
# the sign on the scaffolding with the arcade, shopfronts and light intact.
# Priced from the response's own token usage, so `usd` here is only the UI's
# rough guide — providers/openai_image.py books the exact figure.
row("gpt-image-2", "openai", "GPT Image 2", "image", "openai",
    modes=["t2i", "edit"],
    pricing={"unit": "image", "usd": 0.06, "estimate": True,
             "note": "billed on tokens: ~$0.055 for a 1536x1024 two-image edit"},
    capabilities={"multiRef": 8, "edit": True,
                  "note": "keeps the source plate; the local edit models cannot"},
    local_files={"model": "gpt-image-2"}, sort=59)
# ---- Gemini image (Nano Banana) -------------------------------------------
#
# WHY: measured on Rei E3's storyboard, CITY_CAPTURE_2 b5, one variable changed
# — identical compiled panel prompt, identical four reference sheets. Local
# h3-image-turbo returned three characters standing in a row facing camera;
# gpt-image-2 returned the POV over Miko's shoulder the prompt asks for. The
# panel prompt was never the problem, so the lever is the model, and the hosted
# families belong in the picker rather than in a one-off script.
#
# `pricing` carries BOTH shapes on purpose: `unit`/`usd` is what the UI quotes,
# and `image_out`/`text_in` are the $/1M token rates providers/gemini_image.py
# books the exact ledger figure from. They differ 4x across these three, so a
# single default would misprice two of them.
#
# `imageSize` is a per-model ceiling, not a preference: Lite serves 1K only,
# Pro starts at 1K, and asking for a tier a model does not serve is a 400.
row("nano-banana-2", "gemini", "Nano Banana 2", "image", "google",
    modes=["t2i", "edit"],
    pricing={"unit": "image", "usd": 0.067, "estimate": True,
             "text_in": 0.30, "image_out": 60.0,
             "note": "$0.067 at 1K, $0.101 at 2K; batch is half"},
    capabilities={"multiRef": 14, "edit": True, "imageSize": "2K",
                  "note": "up to 4 character-consistency refs + 10 object refs"},
    local_files={"model": "gemini-3.1-flash-image"}, sort=61)
# The cheapest per image of anything catalogued — and the one row whose caveat
# decides whether it is usable: Google documents NO character-consistency and
# NO style reference support on Lite, only high-fidelity OBJECT refs. Our panels
# are staged on character sheets, so this is a plate/prop/still model here, not
# a panel model. Left ENABLED because that is a real use, and said out loud in
# `note` rather than discovered on a storyboard full of strangers' faces.
row("nano-banana-2-lite", "gemini", "Nano Banana 2 Lite", "image", "google",
    modes=["t2i", "edit"],
    pricing={"unit": "image", "usd": 0.0336, "estimate": True,
             "text_in": 0.30, "image_out": 30.0,
             "note": "1K only; batch is half"},
    capabilities={"multiRef": 14, "edit": True, "imageSize": "1K",
                  "note": "object refs only — no character consistency, so "
                          "identity will NOT hold across panels"},
    local_files={"model": "gemini-3.1-flash-lite-image"}, sort=62)
row("nano-banana-pro", "gemini", "Nano Banana Pro", "image", "google",
    modes=["t2i", "edit"],
    pricing={"unit": "image", "usd": 0.134, "estimate": True,
             "text_in": 0.30, "image_out": 120.0,
             "note": "$0.134 at 1K/2K, $0.24 at 4K; batch is half"},
    capabilities={"multiRef": 14, "edit": True, "imageSize": "2K",
                  "note": "up to 5 character refs + 6 object + 3 style"},
    local_files={"model": "gemini-3-pro-image"}, sort=63)
# `adapter` said "pending" on both of these while `providers/seedream.py` had
# been written and complete for months — so the picker reported a model as
# unimplemented when what it was actually missing is the studio's fal key. Two
# different facts, and only one of them is something a user can fix, which is
# why `blocked` now says the fixable one.
row("seedream-5-pro", "seedream", "Seedream 5.0 Pro", "image", "fal",
    modes=["t2i", "edit"],
    pricing={"unit": "image", "usd": 0.075,
             "note": "<=2.36MP; $0.150 above; extra refs $0.003-0.005"},
    capabilities={"multiRef": 14, "edit": True, "adapter": "seedream",
                  "blocked": _NO_KEY},
    local_files={"adapter": "seedream",
                 "endpoint": "fal-ai/bytedance/seedream/v5/pro"},
    enabled=False, sort=65)
row("seedream-5-lite", "seedream", "Seedream 5.0 Lite", "image", "fal",
    modes=["t2i", "edit"],
    pricing={"unit": "image", "usd": 0.035, "note": "reasoning + up to 14 references"},
    capabilities={"multiRef": 14, "edit": True, "adapter": "seedream",
                  "blocked": _NO_KEY},
    local_files={"adapter": "seedream",
                 "endpoint": "fal-ai/bytedance/seedream/v5/lite"},
    enabled=False, sort=66)

# --- local music (text -> song, kind 'audio') --------------------------------
# Both are native ComfyUI core, so unlike the Krea 2 reference path there is no
# custom node that can be missing. `modes` is ["t2m"] on every row: neither
# model's cover/repaint/edit modes are exposed by core yet, and listing a mode
# the graph cannot build is how a picker offers something that fails.
#
# The catalog ids are the model_map keys with `-local` appended, deliberately —
# `modelKeyOf` strips exactly that, so none of these needs a MODEL_KEY_EXCEPTIONS
# entry. `h3-local` is the cautionary tale (its short id guesses `h3`, which is
# not a model, and every H3 clip failed the day the worker started reading the
# key). Name a music row to survive the strip and the problem does not arise.
mus = AWS["music_models"]
row("minimax-music3-local", "minimax-music3", "MiniMax Music 3", "audio", "local",
    modes=["t2m"], pricing=GPU_PRICING, max_seconds=360,
    local_files=mus["minimax-music3"],
    capabilities={
        "lyrics": True, "instrumental": True, "sectionTags": True,
        "sampleRate": 44100, "attribution": "MiniMax Music 3",
        "promptStyle": "caption",
        "note": "Full songs to 5 minutes with sung vocals. The caption wants "
                "three parts — global metadata (genre, BPM, key, emotional arc), "
                "vocal details (gender, timbre, delivery) and arrangement. "
                "Lyrics take [Intro]/[Verse]/[Chorus]/[Bridge]/[Outro] section "
                "tags. Duration is a CEILING: the model plans its own length "
                "and often finishes early."},
    sort=40)
# 8 steps at cfg 1 against Music 3's 30 at 1.7 — measured 32s vs 91s for the
# same 20 seconds of audio, both warm-ish. It is the one to reach for when you
# want five candidates, not one.
ACE_NOTE = ("Tag-driven rather than prose: comma-separated genre/instrument/mood "
            "tags, with BPM, key, time signature and language as separate typed "
            "controls the encoder actually conditions on. Distilled to 8 steps. "
            "`generate_audio_codes` runs the 5Hz planner LM — on gives better "
            "song structure, off is faster and widens genre variety.")
row("acestep-1.5-local", "acestep", "ACE-Step 1.5 · Turbo", "audio", "local",
    modes=["t2m"], pricing=GPU_PRICING, max_seconds=300,
    local_files=mus["acestep-1.5"],
    capabilities={
        "lyrics": True, "instrumental": True, "sectionTags": True,
        "musicalMeta": True, "sampleRate": 48000, "turbo": True,
        "promptStyle": "tags", "note": ACE_NOTE},
    sort=41)
# XL is a 10GB DiT on the 4B planner instead of a 4.8GB one on the 1.7B, and
# both files are fetched ON FIRST USE (resolve.music_model -> fetchmodel). That
# is the same contract every video row has, but it is ~18GB here, so the row
# says so rather than leaving someone watching a job sit at 0%.
XL_FETCH = "First render on this row downloads ~18GB (XL DiT + the 4B planner)."
row("acestep-1.5-xl-local", "acestep", "ACE-Step 1.5 XL · Turbo", "audio", "local",
    modes=["t2m"], pricing=GPU_PRICING, max_seconds=300,
    local_files=mus["acestep-1.5-xl"],
    capabilities={
        "lyrics": True, "instrumental": True, "sectionTags": True,
        "musicalMeta": True, "sampleRate": 48000, "turbo": True,
        "promptStyle": "tags",
        "note": f"{ACE_NOTE} XL on the 4B planner, which follows a long prompt "
                f"more closely than the 1.7B. {XL_FETCH}"},
    sort=42)
# The un-distilled twin: 50 steps at cfg 7 rather than 8 at 1. Same files as the
# XL turbo row plus its own 10GB checkpoint.
row("acestep-1.5-xl-sft-local", "acestep", "ACE-Step 1.5 XL · SFT", "audio", "local",
    modes=["t2m"], pricing=GPU_PRICING, max_seconds=300,
    local_files=mus["acestep-1.5-xl-sft"],
    capabilities={
        "lyrics": True, "instrumental": True, "sectionTags": True,
        "musicalMeta": True, "sampleRate": 48000,
        "promptStyle": "tags",
        "note": f"{ACE_NOTE.replace('Distilled to 8 steps. ', '')} "
                f"Not distilled — 50 steps at cfg 7, so it is roughly 6x the "
                f"render of the turbo rows and the one to try when a turbo take "
                f"sounds thin. First render downloads ~28GB."},
    sort=43)

# --- local SFX (text -> sound, kind 'audio', mode 't2sfx') -------------------
# `kind` stays 'audio' — `model_catalog.kind`'s check constraint allows exactly
# ('video','image','audio','llm','embed','post'), and inventing a 'sfx' value
# would need a migration AND would make every existing audio surface blind to
# these rows. The MODE is what separates them: `t2m` is a song, `t2sfx` is a
# sound, and `sfxModels()` / `musicModels()` filter on that.
sfx = AWS["sfx_models"]
SA3_NOTE = ("One sentence of sound design, not tags: name the source, the "
            "material and the action, then the space it happens in ('heavy "
            "steel hatch dragging open, pneumatic hiss, long concrete "
            "reverb'). End with the length in seconds — the model was trained "
            "on captions that state it. Stereo out.")
row("stable-audio-3-medium-local", "stable-audio-3", "Stable Audio 3 Medium", "audio",
    "local", modes=["t2sfx"], pricing=GPU_PRICING, max_seconds=380,
    local_files=sfx["stable-audio-3-medium"],
    capabilities={
        "promptStyle": "prose", "turbo": True, "stereo": True,
        "categories": ["sfx", "one-shot", "instrument", "music"],
        "note": f"{SA3_NOTE} Distilled to 8 steps at cfg 1, so a 3-second hit "
                f"is a few seconds of GPU. No negative prompt: at cfg 1 the "
                f"negative branch cannot contribute — use the BASE row for "
                f"that. First render downloads ~10GB."},
    sort=45)
# The un-distilled twin. Same size again on disk, and the ONLY row here where a
# negative prompt does anything — same rule as Anima on the image side.
row("stable-audio-3-medium-base-local", "stable-audio-3", "Stable Audio 3 Medium · Base",
    "audio", "local", modes=["t2sfx"], pricing=GPU_PRICING, max_seconds=380,
    local_files=sfx["stable-audio-3-medium-base"],
    capabilities={
        "promptStyle": "prose", "stereo": True, "negativePrompt": True,
        "categories": ["sfx", "one-shot", "instrument", "music"],
        "note": f"{SA3_NOTE} Not distilled — 50 steps at cfg 7, so it is "
                f"roughly 6x the render of the turbo row, and the only SFX row "
                f"whose negative prompt is live. First render downloads ~10GB."},
    sort=46)
# 2.3GB against 9.2GB, and trained on effects specifically. Worth reaching for
# when the queue is long or the sound is a short one-shot.
row("stable-audio-3-small-sfx-local", "stable-audio-3", "Stable Audio 3 Small · SFX",
    "audio", "local", modes=["t2sfx"], pricing=GPU_PRICING, max_seconds=120,
    local_files=sfx["stable-audio-3-small-sfx"],
    capabilities={
        "promptStyle": "prose", "turbo": True, "stereo": True,
        "categories": ["sfx", "one-shot"],
        "note": f"{SA3_NOTE} The small effects-specialist checkpoint — 2.3GB "
                f"against Medium's 9.2GB, capped at 2 minutes. First render "
                f"downloads ~3.5GB."},
    sort=47)

# --- video -> audio (kind 'audio', mode 'v2a') ------------------------------
# A FIFTH generation family and the first whose INPUT is a video. `modes` is
# what separates it from the SFX rows above — `catalog.sfxModels()` filters on
# `t2sfx` and this one declares `v2a`, so an MMAudio row cannot turn up in the
# picker built for "describe me a sound" and render eight seconds of something
# that needed a clip it was never given. Same discriminator rule the Stable
# Audio rows already follow to stay out of the MUSIC picker.
v2a = AWS["v2a_models"]
row("mmaudio-large-44k-v2-local", "mmaudio", "MMAudio · Large 44k v2", "audio",
    "local", modes=["v2a"], pricing=GPU_PRICING,
    # int(), because `model_catalog.max_seconds` is an INTEGER column and
    # this value is a float in model_map (30.0, beside trained_seconds
    # 8.0 — both are durations and floats are right for the worker, which
    # clamps against them). PostgREST rejects "30.0" for an integer with
    # 22P02 and the whole sync 400s on ONE row, so every model in the
    # catalog silently stops updating until someone reads the body of
    # that error. Measured: the catalog had not synced since this row was
    # added.
    max_seconds=int(v2a["mmaudio-large-44k-v2"]["max_seconds"]),
    local_files=v2a["mmaudio-large-44k-v2"],
    capabilities={
        "promptStyle": "prose", "stereo": False, "video2audio": True,
        # DERIVED from model_map, never hand-written — the `defaultNegative`
        # rule. `local_files` carries the same numbers and is withheld from
        # non-admins by `model_catalog_visible`, so a picker that read it
        # would show the recipe to some accounts and a guess to the rest.
        "steps": v2a["mmaudio-large-44k-v2"]["steps"],
        "cfg": v2a["mmaudio-large-44k-v2"]["cfg"],
        # cfg 4.5 is a real classifier-free scale, so the negative branch is
        # evaluated — unlike every distilled audio row in this catalog, where
        # offering the field would be offering a control that provably cannot
        # change the render.
        "negativePrompt": bool(v2a["mmaudio-large-44k-v2"].get("negative")),
        "trainedSeconds": v2a["mmaudio-large-44k-v2"]["trained_seconds"],
        "syncFps": v2a["mmaudio-large-44k-v2"]["sync_fps"],
        "note": "Scores a SILENT CLIP: it watches the frames and writes a "
                "synchronised soundtrack, so footsteps land on the footfall. "
                "The prompt names the sources you want ('boots on wet gravel, "
                "distant traffic'); the negative keeps things out ('music, "
                "speech'). Trained on 8-second videos — 5-12s is the band "
                "where sync holds. First render downloads ~5.1GB plus a "
                "500MB vocoder.",
    },
    sort=48)

# --- speech (text -> voice, kind 'audio', mode 'tts') ------------------------
# The fourth audio mode. These are the providers `handle_tts` can actually
# reach, which is the whole point of listing them: the panel this replaced
# offered Fish Speech v2, Cartesia Sonic, Kokoro and ElevenLabs Turbo v2.5 in a
# picker the worker never read, so every one of them rendered as OpenAI's
# `alloy`. A row here means `payload.provider` resolves to a real code path.
#
# `provider` is the vendor column; the MODE (`tts`) is what separates these
# from music (`t2m`) and sound effects (`t2sfx`) inside `kind: "audio"`.
row("openai-tts", "openai-tts", "OpenAI · gpt-4o-mini-tts", "audio", "openai",
    modes=["tts"],
    pricing={"unit": "mtok", "usd": 0.60, "estimate": True,
             "note": "billed per character of input"},
    capabilities={
        "voices": ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
        "delivery": "instructions",
        "note": "Six stock voices, no cloning. Delivery is passed as a plain "
                "instruction ('whispered, urgent'), so it takes prose rather "
                "than tags. The dependable default for narration."},
    sort=50)
row("elevenlabs-v3", "elevenlabs", "ElevenLabs v3", "audio", "elevenlabs",
    modes=["tts"],
    pricing={"unit": "mtok", "usd": 30.0, "estimate": True,
             "note": "billed per character; v3 is the expressive tier"},
    capabilities={
        "castVoices": True, "delivery": "tags", "cloning": "hosted",
        "note": "The voices the pipeline casts characters into, so a line "
                "auditioned here is the take the episode will get. Delivery "
                "compiles to a v3 audio tag ([whispers], [angry]). It clones "
                "too, and this is the only engine whose clone can be CAST onto "
                "a character — what it returns is an ordinary voice id, so the "
                "whole episode's dialogue can speak in it."},
    sort=51)
# Cloning. Two rows because the two mean different things by it — one registers
# a voice with a service, the other is zero-shot from the clip every time.
row("fish-s2", "fish", "Fish Audio · S2 (hosted)", "audio", "fish",
    modes=["tts"],
    pricing={"unit": "mtok", "usd": 15.0, "estimate": True,
             "note": "billed per character by Fish Audio"},
    capabilities={
        "cloning": "hosted", "delivery": "none",
        "note": "Speaks as a cloned voice. The reference clip is registered "
                "with Fish once and every later line cites the id it returns, "
                "so cloning here is a one-time upload. Needs a Fish Audio key "
                "(add your own under API keys). No territory or non-commercial "
                "restriction."},
    sort=52)
# Disabled until it has rendered a line on the box: the weights are 11GB, the
# inference tree is a separate venv with its own pinned torch, and offering a
# row that cannot render is exactly the silent failure the rest of this file
# exists to prevent. Flip `enabled` after the engine window's model list s2-pro and one
# successful job.
row("fish-s2-local", "fish", "Fish Speech S2-Pro (local)", "audio", "local",
    modes=["tts"], pricing=GPU_PRICING,
    capabilities={
        "cloning": "zero-shot", "delivery": "tags", "local": True,
        "note": "Zero-shot cloning — no registration, the reference "
                "clip IS the voice and is read at every line. Free per use and "
                "private. LICENCE: Fish Audio Research (NON-COMMERCIAL); the "
                "hosted row has no such restriction. 11GB of weights plus its "
                "own venv."},
    enabled=False, sort=55)
# Voxtral 4B TTS. Disabled for the same reason fish-s2-local is: nothing has
# spoken a line through it yet, and it has no endpoint until VOXTRAL_BASE_URL
# names one (Mistral hosted, or a vLLM-Omni serve — which is a THIRD serving
# stack with its own torch pin, so it gets its own venv the way s2-pro does,
# never the ComfyUI one).
#
# `delivery: "none"` is the fact to read before reaching for it to cure a
# robotic read: ElevenLabs v3 takes inline performance tags and this does not.
# Its expression is the VOICE PRESET (casual/cheerful/neutral x gender), so a
# writer's per-line `delivery` prose has nowhere to go.
row("voxtral-4b-tts", "voxtral", "Voxtral 4B TTS", "audio", "voxtral",
    modes=["tts"],
    pricing={"unit": "mtok", "usd": 0, "estimate": True,
             "note": "free on a local vLLM-Omni serve; billed per character "
                     "on Mistral's hosted endpoint"},
    capabilities={
        "cloning": "none", "delivery": "none",
        "voices": list(("neutral_female", "neutral_male", "casual_female",
                        "casual_male", "cheerful_female")),
        "note": "20 preset voices as fixed voice EMBEDDINGS (5 English, plus "
                "a male/female pair per supported language) — expression is "
                "the preset, and there are no inline performance tags, so a "
                "line's delivery note cannot reach it. 24kHz. Needs "
                "VOXTRAL_BASE_URL. LICENCE: CC-BY-NC (NON-COMMERCIAL) — the "
                "weights and the reference voices both."},
    enabled=False, sort=56)

# Breeze TTS 2 — the pod's own voice engine, and since 2026-09-01 the default
# the PIPELINE casts dialogue with (`DIALOGUE_PROVIDER`). Three modes the
# studio uses: DESIGN a voice from prose (how every character gets one —
# `dialogue_synth.cast_breeze_voice`), CLONE from a clip + its transcript
# (every line, from the designed clip), DIRECT a clone from an instruction
# (the writer's `delivery`). Vocal events in the text — (laugh), (sigh),
# (cough), (clears throat) — are performed, not read. 24 kHz mono. Ranked #1
# open-weight on the Artificial Analysis TTS leaderboard at release.
row("breeze-tts-2", "breeze", "Breeze TTS 2 (local)", "audio", "local",
    modes=["tts"], pricing=GPU_PRICING,
    capabilities={
        "castVoices": True, "cloning": "zero-shot", "delivery": "instruction",
        "local": True, "vocalEvents": ["laugh", "sigh", "cough", "clears throat"],
        "note": "The voices the pipeline now designs characters into, from "
                "the writer's own description — so a line auditioned here is "
                "the take the episode gets. Delivery is an open-language "
                "instruction ('speak slowly, restrained'), not a tag, and "
                "'(sigh)' in the text is performed. Zero-shot cloning from any "
                "clip (the transcript is read off it if you don't type one). "
                "Runs in the studio cloud or on this machine; free per use. LICENCE: BreezeBlue Research "
                "(NON-COMMERCIAL) — the weights and their outputs."},
    sort=53)
# The SECOND local voice engine, the same shape as Breeze — designs a voice
# from prose, clones every line from the designed clip — and **Apache 2.0**
# where Breeze's weights are non-commercial, which is the whole reason it is
# here. `enabled=False` until it has spoken a line on the box: the
# `fish-s2-local` precedent, and this repo's rule for a local row.
#
# WHAT IT CANNOT DO IS IN THE NOTE because the absence is otherwise silent:
# `generate_voice_clone` takes no `instruct`, so a cast line cannot be steered
# by a delivery note the way Breeze's can, and `(sigh)` is stripped rather
# than performed — there is no documented event vocabulary and the word would
# be read aloud. `worker/qwen_voice.py` declares both as capabilities so the
# pipeline never asks.
row("qwen3-tts", "qwen3-tts", "Qwen3-TTS 1.7B (local)", "audio", "local",
    modes=["tts"], pricing=GPU_PRICING, enabled=True,
    capabilities={
        "castVoices": True, "cloning": "zero-shot", "delivery": "none",
        "local": True, "vocalEvents": [],
        "note": "Designs a character's voice from the writer's description and "
                "clones every line from that clip, exactly as Breeze does — and "
                "APACHE 2.0, weights and outputs, where Breeze's are "
                "non-commercial. Two checkpoints (~9GB): VoiceDesign designs, "
                "Base clones, and neither can do the other's job. It cannot "
                "steer a line's delivery (no instruction input on the clone) "
                "and does not perform '(sigh)', so a delivery note reaches the "
                "read through punctuation alone. About 9s to design a voice "
                "and 4s a line on a large GPU, 24kHz mono, and a cloned line "
                "stays close to its designed voice. Runs in the studio cloud "
                "or on this machine; free per use."},
    sort=54)

# --- LLM / embeddings (director backends) -----------------------------------
row("claude-api", "claude", "Claude (API key)", "llm", "anthropic",
    pricing={"unit": "mtok", "usd": 5.0,
             "note": "claude-opus-5: $5/MTok in · $25/MTok out"},
    capabilities={"streaming": True, "tools": True}, sort=71)
row("ollama-local", "qwen3", "Ollama (on this machine)", "llm", "ollama",
    pricing={"note": "runs on this machine"},
    capabilities={"local": True, "tools": True}, sort=72)
row("openai-compat", "custom", "OpenAI-compatible endpoint", "llm", "openai",
    pricing={"note": "depends on endpoint (default gpt-4o-mini $0.15/$0.60 per MTok)"},
    capabilities={"streaming": True}, sort=73)
row("text-embedding-3-small", "openai", "text-embedding-3-small", "embed", "openai",
    pricing={"unit": "mtok", "usd": 0.02, "estimate": True}, sort=80)

# --- post-processing --------------------------------------------------------
row("seedvr2-3b", "seedvr2", "SeedVR2 3B fp8 (restore/upscale)", "post", "local",
    modes=["upscale"], pricing=GPU_PRICING,
    capabilities={"batchRule": "4n+1", "temporal": True}, sort=90)
row("rife47", "rife", "RIFE 4.7 (interpolate)", "post", "local",
    modes=["interpolate"], pricing=GPU_PRICING, sort=91)
row("facedetailer", "impact", "FaceDetailer (hero shots)", "post", "local",
    modes=["facefix"], pricing=GPU_PRICING,
    capabilities={"perFrame": True, "flickerRisk": True}, sort=92)
row("vrgdg-grain-color", "vrgdg", "Film grain + color match (de-AI)", "post", "local",
    modes=["grain", "colormatch", "sharpen"], pricing=GPU_PRICING, sort=93)

ALL_KEYS = ["id", "family", "display_name", "kind", "provider", "modes", "sizes",
            "max_seconds", "fps", "frame_base", "frame_rem", "dim_step", "pricing",
            "capabilities", "local_files", "enabled", "sort"]

# The browser turns a catalog id into a model_map key to put on payload.model_key,
# and it does that by GUESSING: strip "-local", with a hand-kept exception table
# for the ids where that guess is wrong (src/lib/projectSettings.ts modelKeyOf).
# Nothing enforced the two agreeing, and nothing had to while handle_clip_gen
# ignored model_key entirely — the day it started honouring it, "h3-local" became
# "h3", which is not a model, and every H3 clip failed with
# `model 'h3' not available`.
#
# This is the enforcement. Every local row is checked against the model_map entry
# it was actually built from (found by identity, so it cannot drift), and a
# mismatch aborts the generator instead of shipping a catalogue the frontend
# will mistranslate. Keep MODEL_KEY_EXCEPTIONS identical in both files.
MODEL_KEY_EXCEPTIONS = {
    "h3-local": "minimax-h3",
    "h3-turbo-local": "minimax-h3-turbo",
    "h3-pdd-local": "minimax-h3-pdd",
    "h3-lightx2v-local": "minimax-h3-lightx2v",
    "wan22-local": "wan2.2",
    # Desktop-only (model_map.desktop.json): a quantised rung has no row of
    # its own here, so `check_model_keys` never sees these — the picker offers
    # them as VARIANTS of the family row instead.
    "h3-q5-local": "minimax-h3-q5",
    "h3-q4-local": "minimax-h3-q4",
    "h3-q3-local": "minimax-h3-q3",
}


def model_key_of(catalog_id):
    """Mirror of modelKeyOf() in src/lib/projectSettings.ts."""
    if catalog_id in MODEL_KEY_EXCEPTIONS:
        return MODEL_KEY_EXCEPTIONS[catalog_id]
    return catalog_id[: -len("-local")] if catalog_id.endswith("-local") else catalog_id


def check_model_keys(rows):
    """Return [(catalog_id, guessed_key, real_key)] for rows that mistranslate."""
    by_id = {id(v): k for k, v in AWS["models"].items()}
    by_id.update({id(v): k for k, v in AWS["image_models"].items()})
    by_id.update({id(v): k for k, v in AWS.get("music_models", {}).items()})
    by_id.update({id(v): k for k, v in AWS.get("sfx_models", {}).items()})
    by_id.update({id(v): k for k, v in AWS.get("v2a_models", {}).items()})
    bad = []
    for r in rows:
        lf = r.get("local_files")
        real = by_id.get(id(lf)) if lf is not None else None
        if real is None:          # hosted row, or a fragment built inline
            continue
        guess = model_key_of(r["id"])
        if guess != real:
            bad.append((r["id"], guess, real))
    return bad

def check_lora_keys(rows):
    """Return [(catalog_id, key)] for LoRA picks the model_map cannot resolve.

    Same class of bug as check_model_keys, one layer down: the picker offers a
    key, the payload carries it, and the worker drops it with a log line nobody
    reads — the adapter simply never applies. Silent, and indistinguishable from
    "that LoRA doesn't do much". Both sides are generated from this file and the
    map, so they can be held to agree here.
    """
    bad = []
    for r in rows:
        lf = r.get("local_files")
        if not lf:
            continue
        declared = set((lf.get("style_loras") or {}))
        for lora in (r.get("capabilities") or {}).get("styleLoras") or []:
            key = lora["key"] if isinstance(lora, dict) else lora
            if key not in declared:
                bad.append((r["id"], key))
    return bad


def check_sorts(rows):
    """Return [(kind, sort, [ids])] for rows of one kind that share a `sort`.

    Third of the same class as check_model_keys and check_lora_keys: a
    disagreement this file can be held to, whose symptom is silence.
    `catalog.ts` reads the catalog with `.order("sort")` and no tiebreak, so
    two rows of one kind carrying the same number come back in whatever order
    the query plan produced — both render, both work, and only their ORDER is
    arbitrary, which is why it survives review and then moves under you on a
    re-sync, a reindex or a Postgres upgrade.

    It has happened three times here, each time because a row was ADDED AT a
    number another row already held: H3 image PDD onto Klein's 54, H3 video PDD
    onto base H3's 10, and lightx2v onto another video row's 11.

    Grouped by KIND ALONE, deliberately, and not by tier. A picker groups by
    `tierOf`, which is decided in the BROWSER — `byokRows` marks a row the user
    holds a key for, `desktopRows` marks a bundled one, and neither mark is
    stored in this table — so which group a row lands in is not knowable from
    here. At rest every row is the studio's `cloud` tier, so a pod row and a
    hosted row of one kind DO compete (they did: Anima 2.9B and GPT Image 2
    both sat on 59). Unique within the kind is the superset that stays correct
    whatever those marks do at read time.
    """
    by_kind = {}
    for r in rows:
        by_kind.setdefault(r["kind"], {}).setdefault(r["sort"], []).append(r["id"])
    return [(kind, sort, sorted(ids))
            for kind in sorted(by_kind)
            for sort, ids in sorted(by_kind[kind].items())
            if len(ids) > 1]

def emit(rows):
    """The rows as a TypeScript module.

    JSON with a type annotation rather than a `.json` import: `resolveJsonModule`
    would type every field as its literal, so `kind` would be `"video"` instead
    of the union and every consumer would need a cast.
    """
    body = json.dumps(
        [{k: r.get(k) for k in ALL_KEYS} for r in rows], indent=2, ensure_ascii=False)
    return (
        "// GENERATED by scripts/gen_model_catalog.py — do not edit.\n"
        "//\n"
        "// Every model this build can offer, derived from infra/model_map.full.json\n"
        "// (local rows) plus the hand-written hosted rows in the generator. Read it\n"
        "// through src/lib/catalog.ts, never directly: that module is what the\n"
        "// pickers, the frame grids and the studio plane all go through.\n"
        "//\n"
        "// Re-generate after ANY change to the model map or to the generator:\n"
        "//   python3 scripts/gen_model_catalog.py\n"
        "import type { ModelCatalogRow } from \"./db/types\";\n\n"
        f"const CATALOG: ModelCatalogRow[] = {body};\n\n"
        "export default CATALOG;\n")


if __name__ == "__main__":
    mistranslated = check_model_keys(rows)
    if mistranslated:
        print("refusing to generate — these catalog ids do not map to their "
              "model_map key, so the browser would send an unresolvable "
              "payload.model_key:", file=sys.stderr)
        for cid, guess, real in mistranslated:
            print(f"  {cid}: modelKeyOf gives '{guess}', model_map has '{real}'",
                  file=sys.stderr)
        print("  fix: add the pair to MODEL_KEY_EXCEPTIONS here AND in "
              "src/lib/projectSettings.ts", file=sys.stderr)
        sys.exit(1)
    unresolvable = check_lora_keys(rows)
    if unresolvable:
        print("refusing to generate — these rows offer LoRA keys their model_map "
              "entry does not declare, so the worker would drop them silently:",
              file=sys.stderr)
        for cid, key in unresolvable:
            print(f"  {cid}: '{key}' missing from that entry's style_loras",
                  file=sys.stderr)
        sys.exit(1)
    collisions = check_sorts(rows)
    if collisions:
        print("refusing to generate — these rows share a `sort` within one kind, "
              "so the picker would list them in an order nothing decides:",
              file=sys.stderr)
        for kind, sort, ids in collisions:
            print(f"  {kind} sort={sort}: {', '.join(ids)}", file=sys.stderr)
        print("  fix: give each row its own number — take the next free one, or "
              "take the slot and shift everything below it down", file=sys.stderr)
        sys.exit(1)

    text = emit(rows)
    if "--check" in sys.argv:
        try:
            current = open(OUT).read()
        except FileNotFoundError:
            current = ""
        if current != text:
            print(f"{OUT} is stale — run: python3 scripts/gen_model_catalog.py",
                  file=sys.stderr)
            sys.exit(1)
        print(f"{OUT} is up to date ({len(rows)} rows)")
        sys.exit(0)
    with open(OUT, "w") as f:
        f.write(text)
    kinds = {}
    for r in rows:
        kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
    print(f"wrote {OUT}: {len(rows)} rows "
          + ", ".join(f"{n} {k}" for k, n in sorted(kinds.items())))

"""
resolve.py — turn a (model, mode) + params into a ComfyUI API-format graph.

Everything model/file/workflow-specific is read from model_map.json keyed by
MODEL_TIER. Switching tiers (kaggle<->runpod) changes which checkpoints and
workflow templates are resolved — and nothing else. No checkpoint filename is
hardcoded outside model_map.json; the literals in the workflow templates are
overwritten here from the map.
"""
import math, os, json, subprocess

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMFY_ROOT = os.environ.get("COMFY_ROOT", "/kaggle/working/ComfyUI")
MODEL_MAP_PATH = os.environ.get("MODEL_MAP", "/kaggle/working/model_map.json")
WORKFLOWS_DIR = os.environ.get("WORKFLOWS_DIR", os.path.join(REPO_ROOT, "workflows"))
TIER = os.environ.get("MODEL_TIER", "kaggle")

LATENT_CLASSES = {
    "Wan22ImageToVideoLatent", "WanImageToVideo", "WanFirstLastFrameToVideo",
    "EmptyHunyuanLatentVideo", "EmptyHunyuanVideo15Latent", "EmptyLTXVLatentVideo",
    "HunyuanVideo15ImageToVideo", "LTXVImgToVideo",
    "MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo", "EmptyMiniMaxH3LatentAV",
}
# Classes that take the prompt as a plain string input instead of going through
# a CLIPTextEncode node (MiniMax H3 conditions inside the latent builder).
PROMPT_INPUT_CLASSES = {"MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo"}
SAMPLER_CLASSES = {"KSampler", "KSamplerAdvanced"}


class ResolveError(Exception):
    """Raised with a frontend-friendly message when a job can't be resolved."""


# Where a weight file can legitimately sit. `diffusion_models` and `unet` are
# BOTH checked for the same name because ComfyUI treats them as one folder key
# (`diffusion_models` lists both, and city96's GGUF loader registers both), so
# a LINKED ComfyUI may file a checkpoint under either — the same allowance
# `planner.rs::present` makes on the browser side.
_MODEL_DIRS = ("diffusion_models", "unet", "text_encoders", "vae", "checkpoints",
               "loras", "latent_upscale_models", "vae_approx")


def _on_disk(fn):
    for sub in _MODEL_DIRS:
        p = os.path.join(COMFY_ROOT, "models", sub, fn)
        if os.path.exists(p) or os.path.islink(p):
            return True
    return False


def _rename_files(node, swap):
    """Rewrite every weight filename in an entry, at any depth."""
    if isinstance(node, str):
        return swap.get(node, node)
    if isinstance(node, list):
        return [_rename_files(x, swap) for x in node]
    if isinstance(node, dict):
        return {k: _rename_files(v, swap) for k, v in node.items()}
    return node


def apply_rungs(tier):
    """Point each entry at the PRECISION RUNG this machine actually has.

    A model_map entry names one file per role and `engineCatalog` offers up to
    five of the same weights at different precisions, so a laptop holding Klein
    4B at Q4_K_M did not satisfy an entry naming the fp8 — the render would
    have failed on a `value_not_in_list` enum for a model already on the disk.
    `gen_desktop_model_map.mjs` emits `_rungs` (in quality order, best first)
    and this walks it.

    DESKTOP ONLY, BY CONSTRUCTION: `_rungs` exists only in the generated map,
    so on the pod this loop finds nothing and the entry is untouched. Nothing
    here is conditional on the tier name.

    THE DECLARED RUNG ALWAYS WINS when it is present — a machine holding both
    fp8 and Q4 renders on the fp8 the entry names, and only a MISSING declared
    file makes this look further. And the substitution is LOGGED: a render
    quietly using different weights from the ones the map names is the silent
    downgrade this repo keeps being bitten by.

    The alternates the generator emits never change the graph's LOADER (see
    `GGUF_SAFE` there), so this is a rename and nothing else.
    """
    for section in tier.values():
        if not isinstance(section, dict):
            continue
        for key, entry in section.items():
            if not isinstance(entry, dict):
                continue
            alts = entry.pop("_rungs", None)
            if not alts:
                continue
            declared = set()
            for a in alts:
                declared |= set(a["swap"].keys())
            if all(_on_disk(f) for f in declared):
                continue
            for a in alts:
                swap = a["swap"]
                # A file this rung does not rename is one it SHARES with the
                # declared rung (the generator drops identity mappings), so it
                # has to be present too.
                want = set(swap.values()) | (declared - set(swap.keys()))
                if not all(_on_disk(f) for f in want):
                    continue
                section[key] = _rename_files(entry, swap)
                _log(f"{key}: rendering on rung {a['id']} — "
                     + ", ".join(f"{k} -> {v}" for k, v in swap.items()))
                break
    return tier


def load_map():
    with open(MODEL_MAP_PATH) as f:
        mm = json.load(f)
    tier = mm.get(TIER)
    if isinstance(tier, dict):
        apply_rungs(tier)
    return mm


def _islink(v):
    return isinstance(v, list) and len(v) == 2 and isinstance(v[0], str)


def _has_fetcher():
    """Is there a `fetchmodel` on this machine at all?

    THE POD HAS ONE AND A DESKTOP DOES NOT, and that is a fact rather than a
    convention — which is why this asks the PATH instead of reading
    `MODEL_TIER`. `bootstrap.sh` installs the script; a desktop build ships
    the pipeline source and an engine window, and its weights arrive through
    `engineCatalog`. Without this check the first missing file on a laptop is
    `FileNotFoundError: 'fetchmodel'` out of `subprocess`, which names neither
    the model nor the thing to do about it.
    """
    from shutil import which
    return which("fetchmodel") is not None


def _no_fetcher_message(model, files_missing, extra_missing):
    """What to say instead, in the words of the machine the user is on."""
    bits = []
    if files_missing:
        names = ", ".join(sorted({f for _s, f in files_missing}))
        bits.append(f"these files are not on this machine: {names}")
    if extra_missing:
        # NAMED, not counted. A node pack is not something the engine window
        # downloads on demand — `install_engine` clones it as a step — so "1
        # node pack(s) are missing" sends someone to look for a model they will
        # not find. The pack's own directory name is what `engine_status.nodes`
        # reports and what a reinstall would create.
        packs = ", ".join(sorted(os.path.basename(u).replace(".git", "")
                                 for u in extra_missing))
        bits.append(f"these node packs are not installed: {packs}")
    tail = ("Open the engine window and download it there." if files_missing
            else "Reinstall the engine from the engine window — it clones these at install time.")
    return f"'{model}' cannot render here yet — {'; '.join(bits)}. {tail}"


def _audio_entry(section, label, model, mm, files):
    """Look up an audio model_map entry and guarantee its files are on disk.

    The audio sections have no workflow templates and no mode dimension, so
    they need none of `resolve()` — the graphs are built in `graphs.py` from
    these dicts. What they DO need is `ensure_model`'s half of the job: these
    are 2-19GB entries, and a missing file otherwise surfaces as ComfyUI
    rejecting the prompt with an enum error naming a `vae_name` — which reads
    as a code bug rather than "that model was never fetched onto this box".

    Deliberately separate from `ensure_model` rather than a branch inside it:
    that one walks `modes`, `gguf`, `extra_nodes` and per-mode checkpoints,
    none of which exist here, and teaching it a second schema would make both
    harder to read. `files` is the (subdir, filename) list this family needs,
    since that is the only part music and SFX genuinely disagree about.
    """
    tier = (mm or load_map())[TIER]
    entries = tier.get(section) or {}
    if model not in entries:
        have = ", ".join(sorted(entries)) or "none"
        raise ResolveError(
            f"{label} model '{model}' not available on tier '{TIER}' (have: {have})")
    m = entries[model]
    needed = files(m)

    def present(sub, fn):
        p = os.path.join(COMFY_ROOT, "models", sub, fn)
        return os.path.exists(p) or os.path.islink(p)

    missing = [(s, f) for (s, f) in needed if not present(s, f)]
    if missing:
        if not _has_fetcher():
            raise ResolveError(_no_fetcher_message(model, missing, []))
        _log(f"fetchmodel {model} (missing {missing})")
        r = subprocess.run(["fetchmodel", model], capture_output=True, text=True)
        print(r.stdout[-2000:], flush=True)
        if r.returncode != 0:
            raise ResolveError(f"fetchmodel {model} failed: {r.stderr[-300:]}")
        still = [(s, f) for (s, f) in needed if not present(s, f)]
        if still:
            raise ResolveError(
                f"{label} model '{model}' files still missing after fetch: {still}")
    return m


def _music_files(m):
    tes = list(m.get("text_encoders") or [])
    if m.get("text_encoder"):
        tes.append(m["text_encoder"])
    return ([("diffusion_models", m["unet"]), ("vae", m["vae"])]
            + [("text_encoders", t) for t in tes])


def _sfx_files(m):
    # Stable Audio 3 ships MODEL+VAE in one checkpoint (hence no `vae` row) and
    # conditions through a separate t5gemma encoder.
    return [("checkpoints", m["checkpoint"]),
            ("text_encoders", m["text_encoder"])]


def music_model(model, mm=None):
    """A `music_models` entry, with its files guaranteed on disk."""
    return _audio_entry("music_models", "music", model, mm, _music_files)


def sfx_model(model, mm=None):
    """An `sfx_models` entry, with its files guaranteed on disk."""
    return _audio_entry("sfx_models", "sfx", model, mm, _sfx_files)


def _v2a_files(m):
    """Every MMAudio file lands in ONE new directory, `models/mmaudio`.

    That is the pack's own doing — `nodes.py` registers the folder itself
    (`folder_paths.add_model_folder_path("mmaudio", …)`) and all four of its
    loaders read their dropdown from it, so the transformer, the audio VAE,
    the synchformer and the CLIP tower sit side by side rather than in the
    four directories ComfyUI would otherwise put them in. Splitting them the
    "tidy" way makes `get_full_path_or_raise("mmaudio", …)` fail on a file
    that is demonstrably on the box.

    `models/mmaudio` is also a NEW directory, which means a line in
    the engine's model directories in this same commit — a real directory shadowing
    the /data symlink is the failure that has cost this repo three diagnoses
    (latent_upscale_models, frame_interpolation, ultralytics).
    """
    return [("mmaudio", m[k]) for k in ("model", "vae", "synchformer", "clip")]


def v2a_model(model, mm=None):
    """A `v2a_models` entry (video -> audio), with its files on disk."""
    return _audio_entry("v2a_models", "video-to-audio", model, mm, _v2a_files)


def ensure_model(model, mm=None):
    """Make sure the model's files + extra_nodes are present; fetchmodel if not."""
    mm = mm or load_map()
    tier = mm[TIER]
    if model not in tier["models"]:
        raise ResolveError(f"model '{model}' not available on tier '{TIER}'")
    m = tier["models"][model]

    needed = []  # (subdir, filename)
    for mode_spec in m.get("modes", {}).values():
        for k in ("checkpoint", "high", "low"):
            fn = mode_spec.get(k)
            if fn and not fn.startswith("RESOLVE_"):
                sub = "unet" if m.get("gguf") else "diffusion_models"
                needed.append((sub, fn))
    if isinstance(m.get("vae"), str):
        needed.append(("vae", m["vae"]))
    if isinstance(m.get("audio_vae"), str):   # LTX 2.3 is AV-native: two VAEs
        needed.append(("vae", m["audio_vae"]))
    for key in ("lora", "style_lora"):        # per-model style LoRA (LTX / Wan / H3)
        if m.get(key):
            needed.append(("loras", m[key]))
    # LTX 2.5's second stage and its MSR reference path each need a file that
    # is neither a checkpoint nor a style LoRA. Both are load-bearing rather
    # than optional — without the upscaler the two-pass graph cannot run at
    # all, and without the MSR IC-LoRA the r2v guide has no slot embeddings —
    # so they belong in the presence check. Left out, the job fails inside
    # ComfyUI on a filename, which says nothing about which model_map entry
    # is short a file.
    if m.get("latent_upscaler"):
        needed.append(("latent_upscale_models", m["latent_upscaler"]))
    if m.get("msr_lora"):
        needed.append(("loras", m["msr_lora"]))
    # PDD's two files, in the folder its own pack registers. Both, because this
    # function has no mode to narrow by — it already walks every mode's
    # checkpoint for the same reason, and the file follows the checkpoint
    # (fl2va for t2v/i2v/flf, ref2va for r2v).
    #
    # `turbo_lora` is still deliberately absent from this walk and remains the
    # known gap it always was; this one is here because the DESKTOP is the
    # caller that cannot recover. On the pod a missing file shells out to
    # `fetchmodel minimax-h3-pdd` and fixes itself; on a laptop there is no
    # fetcher, so without this the render reaches ComfyUI and dies on a
    # `pdd_file` enum — a message about a dropdown, naming neither the model
    # nor the download that would fix it.
    for _k in ("fl2va", "ref2va"):
        _f = (m.get("pdd") or {}).get(_k)
        if _f:
            needed.append(("pdd_acc", _f))
    for enc in m.get("text_encoders", []):
        needed.append(("text_encoders", enc))

    def present(sub, fn):
        p = os.path.join(COMFY_ROOT, "models", sub, fn)
        return os.path.exists(p) or os.path.islink(p)

    extra_missing = [u for u in m.get("extra_nodes", [])
                     if not os.path.exists(os.path.join(COMFY_ROOT, "custom_nodes",
                                                          os.path.basename(u).replace(".git", "")))]
    files_missing = [(s, f) for (s, f) in needed if not present(s, f)]

    if files_missing or extra_missing or m.get("auto_download"):
        if not _has_fetcher():
            raise ResolveError(_no_fetcher_message(model, files_missing, extra_missing))
        print(f"[resolve] fetchmodel {model} (missing files={files_missing} nodes={extra_missing})", flush=True)
        r = subprocess.run(["fetchmodel", model], capture_output=True, text=True)
        print(r.stdout[-2000:], flush=True)
        if r.returncode != 0:
            raise ResolveError(f"fetchmodel {model} failed: {r.stderr[-300:]}")
        still = [(s, f) for (s, f) in needed if not present(s, f)]
        if still:
            raise ResolveError(f"model '{model}' files still missing after fetch: {still}")
    return m


# Linear scale for reference-video frames against the render's width. 0.5 is
# a quarter of the tokens; see _wire_refs' docstring for the measurement. Bump
# DOWN before bumping up — the failure it guards against is an instant OOM.
REF_VIDEO_SCALE = 0.5


def _wire_refs(g, images=None, videos=None, audios=None,
               render_dims=None, render_frames=None):
    """Point a MiniMaxH3ReferenceToVideo node at the shot's staged references.

    The node takes four autogrow families, each a flat key set on the node
    (`ref_images.ref_image_0`, `ref_videos.ref_video_0`, ...). Per its own
    schema: ref_images/ref_videos want IMAGE, ref_audios/ref_video_audios want
    AUDIO — so a reference *video* is loaded as FRAMES, not as a VIDEO object.
    VHS_LoadVideo returns both (IMAGE at slot 0, AUDIO at slot 2), which lets a
    single upload contribute its picture and its soundtrack together.

    Caps come from the schema: 9 images, 3 videos, 3 audios. A slot wired to
    nothing is a graph error, so unused slots are removed rather than left.

    A REFERENCE VIDEO IS LOADED AT HALF THE RENDER'S LINEAR SIZE, and that is
    a VRAM decision measured on this card, not a style choice. The node scales
    ref IMAGES down to the generation's pixel area but encodes ref VIDEOS at
    their own (rounded) resolution, and reference tokens ride through every
    sampling step — so a full-length source staged as <Video 1> (the video_edit
    path) exactly doubles the DiT sequence, and three attempts at 328f
    1280x736 + a same-size 328f reference all died on the FIRST sampling step
    with `Allocation on device` (2026-08-23) while the identical render with ~8
    image refs fits. Half linear = a quarter of the tokens (~1.25x a plain
    render), keeps the full temporal structure — which is what an edit must
    preserve — and mirrors the node's own 'match' policy for images one octave
    down. Temporal subsampling is NOT the lever: the node reads the batch as
    24fps frames, so every-2nd-frame is double-speed motion, corrupting the
    timing an edit exists to hold.

    A `videos` entry is a staged filename, or `{"name", "width", "height"}`
    when the caller knows the source's dims — a source already at or below the
    cap keeps its native size (custom 0/0), because VHS scales UP as readily as
    down and an upscaled reference is pure token waste. `render_frames` caps
    the load at what the node would truncate to anyway (it trims refs to the
    render's frame count, then down to the 17n+5 grid).
    """
    node_id = next((nid for nid, n in g.items()
                    if n.get("class_type") == "MiniMaxH3ReferenceToVideo"), None)
    if node_id is None:
        return
    ins = g[node_id]["inputs"]
    for k in [k for k in ins if k.startswith(("ref_images.", "ref_videos.",
                                              "ref_audios.", "ref_video_audios."))]:
        old = ins.pop(k)
        if _islink(old):
            # Drop the template's placeholder loader — unless another node
            # still consumes it (the audiolock template shares its LoadAudio
            # between ref_audio_0 and VRGDG_MiniMaxH3AudioDrive).
            still_used = any(
                _islink(v) and v[0] == old[0]
                for onid, onode in g.items() if onid != old[0]
                for v in onode.get("inputs", {}).values())
            if not still_used:
                g.pop(old[0], None)
    nid = [max([int(k) for k in g if k.isdigit()] or [0])]

    def add(node):
        nid[0] += 1
        g[str(nid[0])] = node
        return str(nid[0])

    for i, name in enumerate((images or [])[:9]):
        ins[f"ref_images.ref_image_{i}"] = [add(
            {"class_type": "LoadImage", "inputs": {"image": name}}), 0]

    for i, entry in enumerate((videos or [])[:3]):
        name = entry["name"] if isinstance(entry, dict) else entry
        src_w = int(entry.get("width") or 0) if isinstance(entry, dict) else 0
        # Half the render's width, snapped to /32 so the node's canvas rounding
        # cannot nudge it; custom_height 0 keeps the source aspect (VHS derives
        # it and rounds to /8). Unknown source dims get the cap regardless — a
        # ref video LARGER than half-render is the common case, and a smaller
        # one mildly upscaled is a token waste, not a correctness break.
        cw = 0
        if render_dims:
            cap_w = max(32, int(render_dims[0] * REF_VIDEO_SCALE / 32) * 32)
            if not src_w or src_w > cap_w:
                cw = cap_w
        # force_rate 24 matches the node's "frames at 24 fps" contract;
        # frame_load_cap 360 is its 15s ceiling, tightened to the render's own
        # count when known (the node truncates there anyway — loading past it
        # only spends decode time and RAM).
        cap_f = min(360, int(render_frames)) if render_frames else 360
        v = add({"class_type": "VHS_LoadVideo", "inputs": {
            "video": name, "force_rate": 24, "custom_width": cw, "custom_height": 0,
            "frame_load_cap": cap_f, "skip_first_frames": 0, "select_every_nth": 1}})
        ins[f"ref_videos.ref_video_{i}"] = [v, 0]           # IMAGE (frames)
        ins[f"ref_video_audios.ref_video_audio_{i}"] = [v, 2]  # AUDIO (soundtrack)

    for i, name in enumerate((audios or [])[:3]):
        ins[f"ref_audios.ref_audio_{i}"] = [add(
            {"class_type": "LoadAudio", "inputs": {"audio": name}}), 0]


def _wire_msr_refs(g, images=None, background=None):
    """Point the LTX 2.5 MSR guide nodes at the shot's staged references.

    ComfyUILTX25MSRMultiReferenceGuide takes up to four subject slots plus a
    DEDICATED background slot, each an optional single-image input with a
    learned slot embedding — so unlike MiniMaxH3ReferenceToVideo's flat
    autogrow list, WHICH slot a picture lands in is meaningful. pic1..pic4
    take the staged subject images; `background` takes the location plate.

    The caller SAYS which is which (`ref_background=`) rather than this
    guessing, because the guess it used to make — "a fifth image must be the
    background" — is wrong in the common case: a block stages one character
    and one location, and that location would land in pic2, a subject slot,
    with a subject's slot embedding on it. Falling back to the fifth image
    keeps every existing caller working; a caller that knows better says so.

    Both guide nodes — one per pass — get the same links: the second pass
    re-guides the upscaled latent, and a pass that saw different references
    would drift the identities it is there to hold.
    """
    guides = [nid for nid, n in g.items()
              if n.get("class_type") == "ComfyUILTX25MSRMultiReferenceGuide"]
    if not guides:
        return
    imgs = list(images or [])
    if background is None and len(imgs) > 4:
        background = imgs[4]
    nid = [max([int(k) for k in g if k.isdigit()] or [0])]

    def add(name):
        nid[0] += 1
        g[str(nid[0])] = {"class_type": "LoadImage", "inputs": {"image": name}}
        return str(nid[0])

    loads = {name: add(name)
             for name in dict.fromkeys(imgs[:4] + ([background] if background else []))}
    for gid in guides:
        ins = g[gid]["inputs"]
        for i, name in enumerate(imgs[:4]):
            ins[f"pic{i + 1}"] = [loads[name], 0]
        if background:
            ins["background"] = [loads[background], 0]


def frame_count(model, duration_ms, mm=None):
    """Legal frame count for THIS model at a wall-clock duration.

    Invariant #5's generic form, exposed so a caller does not have to hardcode
    one family's grid: `fps` + `frame_base`/`frame_rem` off the model entry,
    the same three keys `resolve()` reads a few dozen lines below. H3 is
    17n+5 at 24fps, LTX 2.5 is 8n+1 at 24fps.

    It exists because `handle_clip_gen` — the free-standing "make me this clip"
    path — computed its length with `h3_timing.pad17` and passed it as
    `exact_frames`, which `resolve()` is documented to TRUST. So every
    non-H3 family rendered an off-grid count from that path: LTX 2.5 was
    enabled in the catalog and could not legally render a single clip through
    it. Rounds UP, like pad17: render long, trim exact.
    """
    mm = mm or load_map()
    m = (mm[TIER].get("models") or {}).get(model) or {}
    fps = float(m.get("fps") or 24)
    base = int(m.get("frame_base", 8))
    rem = int(m.get("frame_rem", 1))
    n = max(rem, int(math.ceil(max(1, int(duration_ms)) / 1000.0 * fps)))
    return n + (rem - n) % base


def cap_dims_to_source(model, width, height, src_w, src_h, mm=None):
    """Shrink a requested frame so it can never exceed the SOURCE it derives
    from. The `video_edit` ceiling.

    An edit conditions on the source clip as <Video 1> and is told to preserve
    everything the instruction does not name, so it can only ever reproduce
    detail the source already has: asking for a LARGER frame is an upsample
    wearing an edit's clothes. It is also charged TWICE, which is what makes it
    a crash rather than a quality question — the DiT sequence is
    frames x w x h, and `_wire_refs` stages the reference at half the RENDER's
    width (REF_VIDEO_SCALE), so an oversized request inflates the target and
    its own reference together.

    MEASURED 2026-09-04, and it is the whole reason this exists. b13's take was
    rendered 864x480 while its block's stored `params` say 1280x736 — the
    modal sends those, and the precedence in `handle_video_edit` puts the
    caller ahead of the source — so the edit ran at 2.27x the source's pixels
    and died two seconds after the model load, on the first sampling step:
    `int8_linear ... torch.cat -> torch.OutOfMemoryError: Allocation on
    device`. 294 frames of 1280x736 plus its 640x368 reference is 346M
    px-frames against 152M at the source's own size, on a card that had only
    53.5GB usable because the text encoder freed 5.2 of its 25.9GB before
    sampling (peak allocated 82.2GB of 96GB). Capped, the identical job is
    146M px-frames.

    UNIFORM SCALE, NEVER PER-AXIS. The request's aspect is the block's and is
    kept — this shrinks the frame, it must not reshape it. Capping each axis
    independently against a source of a different aspect (864x480 is 1.80,
    the request 1.739) would squash the picture to fit a rectangle nobody
    asked for.

    FLOORED to the model's `dim_step`, not rounded. resolve() rounds to
    NEAREST a few hundred lines below, which would hand back up to half a step
    over the ceiling; flooring here makes that snap a no-op and keeps the
    promise the name makes. The cost is that the kept aspect is quantised to
    that grid, which is true of every render here already.

    An unknown or zero source size caps NOTHING and returns the request
    unchanged. There is no ceiling to apply, and inventing one is worse than
    honouring what was asked for.
    """
    w, h = int(width or 0), int(height or 0)
    sw, sh = int(src_w or 0), int(src_h or 0)
    if w <= 0 or h <= 0 or sw <= 0 or sh <= 0:
        return w, h
    # Integer arithmetic throughout: the binding axis is whichever runs out
    # first, and scaling by that exact ratio in floats put the non-binding
    # axis a hair under its own step (480.00000000000006 -> 15.0 -> 14) and
    # silently lost 32px.
    if sw * h <= sh * w:
        num, den = sw, w          # width binds
    else:
        num, den = sh, h          # height binds
    if num >= den:                # already inside the source on both axes
        return w, h
    m = (mm or load_map())[TIER].get("models", {}).get(model) or {}
    step = int(m.get("dim_step", 0) or 0) or 1
    return (max(step, w * num // den // step * step),
            max(step, h * num // den // step * step))


def _snap_context_frames(want):
    """Largest legal H3 clip length ≤ `want`, for a node whose context_length
    is a plain INT (the MultiRef pack; the enum pack snaps off its own list).

    "Legal" is invariant #5's 17n+5 grid — the pack tests exactly that
    (`n >= 5 and (n - 5) % 17 == 0`) to decide whether the pinned frames go in
    as ONE multi-frame guide or as n separate still guides. Off-grid still
    renders, so this is not a validation fix: it is the difference between the
    model reading a run of motion and reading a stack of unrelated stills, and
    the fallback announces itself only in ComfyUI's log.

    Always rounds DOWN, never up, for the same reason the enum path does:
    the pinned window comes off the head of the render, which is the window the
    block's warmup trim removes. Pinning more than the trim takes replays the
    previous block's tail inside the delivered content.
    """
    want = int(want)
    if want < 5:
        return 1          # a single still is the node's other native shape
    return 5 + ((want - 5) // 17) * 17


def _wire_motion_context(g, ctx):
    """Splice MiniMaxH3MotionContext between the H3 latent builder's
    CONDITIONING output and its consumer (BasicGuider), feeding it the
    previous take's tail frames + audio via VHS_LoadVideo.

    The context frames occupy the head of the render — the same window the
    block pipeline's warmup already trims — so downstream timing math needs no
    change: context_length is set to the block's warmup frame count.

    ctx keys beyond the original {video, context_length, skip_frames}:
      latent_file  absolute path of the chained-from block's saved AV latent.
                   When set (the CALLER verified the file exists), the node
                   slices context straight from the latent instead of decoding
                   and re-encoding it, so that loss stops compounding along a
                   chain. On the MultiRef pack this covers the SOUND only —
                   `context_latent` is read inside its audio branch and the
                   picture always comes from `context_frames`, so the VHS
                   frames are the picture source rather than a fallback.
                   (NikoDemon80 0.3.0 takes both from the latent.)
      load_cap     how many frames to read after `skip_frames`, 0 = to the
                   end of the file. A block take is already trimmed so 0 is
                   right there; a timeline clip's file is not.
      spec         the installed node's /object_info entry, or None (tests).

    There are two live packs and they disagree about this node's signature, so
    the inputs are fitted to the INSTALLED one (same treatment as
    Krea2EditRebalance) rather than to whichever we ported from:
      * MultiRef (seitanism, what the engine window's node-pack install puts on the
        pod) keeps the original shape — `context_length` a plain INT,
        encode_mode/anchor_mode/crop/audio_mode as real widgets — and adds
        context_latent. `_snap_context_frames` puts the INT on the 17n+5 grid.
      * NikoDemon80 0.2.0+ turned `context_length` into a COMBO of legal
        frame-count strings ("5"/"22"/"39"/"56") and made those four widgets
        internal constants.
    Unknown keys are dropped, and context_length snaps to the largest legal
    value ≤ the requested one so the pinned window never outgrows the trim.
    audio_context_length follows the snapped picture window — pinned audio
    longer than the trim would leak the previous block's tail INTO the
    content window as an audible repeat.
    """
    builder = next((nid for nid, n in g.items()
                    if n.get("class_type") in PROMPT_INPUT_CLASSES), None)
    if builder is None:
        raise ResolveError("motion_ctx was requested but this workflow has no "
                           "MiniMax H3 latent builder to attach it to")
    cond_consumers = [(nid, k, v) for nid, n in g.items()
                      for k, v in n.get("inputs", {}).items()
                      if _islink(v) and v[0] == builder and k == "conditioning"]
    latent_link = next((v for n in g.values()
                        for k, v in n.get("inputs", {}).items()
                        if _islink(v) and v[0] == builder and k == "latent_image"), None)
    if not cond_consumers or latent_link is None:
        raise ResolveError("motion_ctx: could not find the builder's conditioning/"
                           "latent consumers in this workflow")
    vae_id = audio_vae_id = None
    for nid, n in g.items():
        if n.get("class_type") == "VAELoader":
            if "audio" in str(n["inputs"].get("vae_name", "")).lower():
                audio_vae_id = nid
            else:
                vae_id = nid
    if vae_id is None:
        raise ResolveError("motion_ctx: workflow has no video VAELoader")

    nid = max((int(k) for k in g if k.isdigit()), default=0)

    def add(node):
        nonlocal nid
        nid += 1
        g[str(nid)] = node
        return str(nid)

    # `load_cap` 0 means "to the end of the file", which is right for a block
    # take (already trimmed to its visible content) and WRONG for a timeline
    # clip, whose file routinely runs past the point the user trimmed it to.
    # Loading past that pins motion from frames nobody sees — so the caller
    # can say where the predecessor's content actually ends.
    vhs = add({"class_type": "VHS_LoadVideo", "inputs": {
        "video": ctx["video"], "force_rate": 24,
        "custom_width": 0, "custom_height": 0,
        "frame_load_cap": int(ctx.get("load_cap") or 0),
        "skip_first_frames": int(ctx.get("skip_frames") or 0),
        "select_every_nth": 1}})

    spec = ctx.get("spec")
    decl = ((spec or {}).get("input") or {})
    all_in = {**(decl.get("required") or {}), **(decl.get("optional") or {})}
    want = int(ctx.get("context_length") or 22)
    sig = all_in.get("context_length")
    if sig and isinstance(sig[0], list) and sig[0] and isinstance(sig[0][0], str):
        legal = sorted(int(x) for x in sig[0])
        fit = [x for x in legal if x <= want]
        ctx_len = str(fit[-1] if fit else legal[0])
    else:
        ctx_len = _snap_context_frames(want)   # INT input: snap it ourselves

    mc_inputs = {
        "conditioning": [builder, cond_consumers[0][2][1]],
        "vae": [vae_id, 0],
        "latent": list(latent_link),
        "context_frames": [vhs, 0],
        "context_audio": [vhs, 2],
        "context_length": ctx_len,
        "audio_context_length": int(ctx.get("audio_context_length") or int(ctx_len)),
        # pre-0.2.0 inputs; _fit_node_inputs drops them on a current pack.
        "encode_mode": "video",
        "anchor_mode": "head",
        "crop": "disabled",
        "audio_mode": "timeline",
    }
    if audio_vae_id is not None:
        mc_inputs["audio_vae"] = [audio_vae_id, 0]
    if ctx.get("latent_file") and (spec is None or "context_latent" in all_in):
        ld = add({"class_type": "MiniMaxH3MotionContextLoadLatent",
                  "inputs": {"latent_path": ctx["latent_file"], "clip_index": 0}})
        mc_inputs["context_latent"] = [ld, 0]
    from graphs import _fit_node_inputs
    mc = add({"class_type": "MiniMaxH3MotionContext",
              "inputs": _fit_node_inputs(mc_inputs, spec)})
    for onid, key, _v in cond_consumers:
        g[onid]["inputs"][key] = [mc, 0]


def _wire_context_save(g, save):
    """Persist this render's AV latent beside its decode so the NEXT chained
    block can pin motion context straight from the latent (the pack's v0.2.0
    lossless path). save = {"prefix": filename_prefix}. Only H3 graphs qualify
    — the save node handles H3's nested video/audio latent pairs, and saving a
    Wan latent through it would just write junk — and a graph with no video
    decode reading the sampler is left alone."""
    if not any(n.get("class_type") in PROMPT_INPUT_CLASSES for n in g.values()):
        return False
    link = None
    for n in g.values():
        if n.get("class_type") == "VAEDecode":
            v = n.get("inputs", {}).get("samples")
            if _islink(v):
                link = list(v)
                break
    if link is None:
        return False
    nid = max((int(k) for k in g if k.isdigit()), default=0) + 1
    g[str(nid)] = {"class_type": "MiniMaxH3MotionContextSaveLatent",
                   "inputs": {"latent": link,
                              "filename_prefix": save["prefix"],
                              "clip_index": 0}}
    return True


MODEL_LOADERS = ("UNETLoader", "UnetLoaderGGUF", "UnetLoaderGGUFAdvanced")


def _log(msg):
    """This module imports os/json/subprocess and nothing else on purpose — its
    tests run off-pod, and `status.log` would drag in requests/comfy/sb. Same
    stdout the worker's journal captures either way."""
    print(f"[resolve] {msg}", flush=True)


def lora_stack(m, loras):
    """Turn a job's LoRA KEYS into [(filename, strength), …] for this model.

    The video side now stacks adapters the way the image side already does:
    `model_map`'s `style_loras` is a key -> filename table, the browser only
    ever ships keys (catalog `capabilities.styleLoras`), and filenames stay on
    the pod. A key the model does not declare is DROPPED with a log line rather
    than passed to ComfyUI, which would fail the whole render on a missing file.

    Why keys and not a checkpoint variant per LoRA: these are concept adapters
    (anatomy, an action, a camera look), and combining two is the ordinary case.
    A style variant that replaces the checkpoint is still its own model_map
    entry, and keeps its baked `style_lora` so episodes already planned against
    it render identically.

    Note there is deliberately no trigger-prepending here, unlike
    `handlers.images._resolve_loras`. An H3 prompt is the three-field envelope
    `h3_prompt.py` compiles (invariant #6); pasting a bare trigger sentence at
    the front of it corrupts the format the model was trained to read. Trigger
    phrasing for these belongs inside the shot description, and the catalog hint
    is where each author's wording is recorded.
    """
    catalogued = m.get("style_loras") or {}
    per_key = m.get("lora_defaults") or {}
    default_strength = float(m.get("lora_strength", 1.0) or 1.0)

    wanted = []
    for item in (loras or []):
        if isinstance(item, str):
            wanted.append((item, None))
        elif isinstance(item, dict):
            k = item.get("key") or item.get("lora") or item.get("name")
            if k:
                wanted.append((k, item.get("strength", item.get("weight"))))

    out, seen = [], set()
    for key, strength in wanted:
        if key in seen:
            continue
        seen.add(key)
        entry = catalogued.get(key)
        if entry is None and isinstance(key, str) and key.endswith(".safetensors"):
            entry = key         # escape hatch: a file dropped on the pod by hand
        if entry is None:
            _log(f"lora '{key}' is not declared by this model — dropped")
            continue
        if isinstance(entry, str):
            s = strength if strength is not None else per_key.get(key, default_strength)
            out.append((entry, float(s)))
            continue
        # A multi-FILE adapter: one pick, several files that only work together.
        # The shape that forced it: a stills-trained file at 1.0 that restores
        # detail the model renders vague, plus a video-trained one at 0.35 that
        # holds it through motion, whose author is explicit that neither
        # carries a generation alone. Two picker keys would let someone take half of it,
        # and half of it is the failure the pairing exists to prevent.
        #
        # So the declared per-file strengths are the author's recipe and their
        # RATIO is the meaningful part — a caller's strength SCALES the set
        # rather than replacing each file's. 1.0 is the recipe as published.
        mult = float(strength) if strength is not None else float(per_key.get(key, 1.0))
        for part in entry:
            fn = part.get("file") if isinstance(part, dict) else part
            if not fn:
                continue
            ps = float(part.get("strength", default_strength)) \
                if isinstance(part, dict) else default_strength
            out.append((fn, ps * mult))
    return out


def lora_triggers(model, loras, mm=None):
    """Trigger tokens the picked LoRAs need PRESENT IN THE PROMPT, in pick order.

    Most H3 adapters need none — they were trained on ordinary captions and
    respond to ordinary description. A few were trained with a token prepended
    that their captions never contain, so the token appears nowhere in the prose
    the adapter learned and the adapter contributes NOTHING unless the prompt
    carries it. `model_map`'s
    `lora_triggers` table is where that fact lives, same key space as
    `style_loras` and the same rule about what reaches the browser: the catalog
    ships the token as a picker chip, the map is what the render reads.

    A PICK MAY ALSO CARRY ITS OWN `trigger`, which is how a user's hub-
    downloaded adapter gets one: it is in no model_map, so it arrives at
    `lora_stack` as a bare filename and its token can only arrive beside it.
    The table wins where both exist.

    What this does NOT do is prepend anything, and neither does `lora_stack` —
    that is the whole reason this is a separate lookup returning strings.
    `resolve()`'s own `trigger` prepend puts the token in front of the entire
    positive string, which for H3 is above `subject_definitions:`: present in
    the string, outside every field the model reads. Placement belongs to
    `h3_prompt` (`compile_block(lora_triggers=…)` / `with_triggers`), which owns
    the format.

    Unknown model -> no tokens rather than an error: `resolve()` is the place
    that refuses an unresolvable model, and a duplicate raise here would fail a
    render one step earlier with a worse message.
    """
    tier = (mm or load_map()).get(TIER) or {}
    m = (tier.get("models") or {}).get(model) or {}
    table = m.get("lora_triggers") or {}

    out, seen = [], set()
    for item in (loras or []):
        key = item if isinstance(item, str) else (
            item.get("key") or item.get("lora") or item.get("name")
            if isinstance(item, dict) else None)
        # A PICK MAY CARRY ITS OWN TOKEN, and on the desktop that is the only
        # place it can live. `lora_triggers` is keyed by the model_map's own
        # adapter names, and a user's hub download is not in any map — it
        # reaches `lora_stack` as a bare filename through the escape hatch
        # there, so its token reaches here the same way: on the pick. The
        # table still wins where both exist, because that is the studio's own
        # measured value for its own adapter.
        trig = table.get(key)
        if trig is None and isinstance(item, dict):
            trig = item.get("trigger")
        # A multi-file adapter can need one token per file — a stills half
        # and a motion half are routinely trained with different tokens — so a
        # value here is a token or a list of them.
        for t in ([trig] if isinstance(trig, str) else (trig or [])):
            if not t or t.lower() in seen:
                continue
            seen.add(t.lower())
            out.append(t)
    return out


def _snap32(v):
    """Round a dimension to the /32 grid H3 samples on, never below 32."""
    return max(32, int(round(float(v) / 32.0)) * 32)


REFINE_DEFAULTS = {"scale": 1.25, "steps": 4, "denoise": 0.2,
                   "scheduler": "beta", "upscale_method": "lanczos",
                   "freeze_audio": True}


def refine_spec(m, want):
    """The refine recipe for this model+job -> dict, or None for single pass.

    `want` is `params.refine` / `payload.refine`: False or None is off, True
    takes the model's recipe, a dict overrides individual keys. A model with no
    `refine` block declines regardless — the pass is only meaningful where the
    entry says what to sample.
    """
    if not want:
        return None
    base = m.get("refine")
    if not base:
        return None
    spec = {**REFINE_DEFAULTS, **base}
    if isinstance(want, dict):
        spec.update({k: v for k, v in want.items() if v is not None})
    return spec


def _splice_h3_refine(g, model, spec, *, width, height, seed):
    """Add a second, higher-resolution sampler pass to an H3 graph.

    Adapted from vrgamedevgirl's `minimax_ref2video_2pass_audio_driven` graph:
    sample, decode, upscale the picture, re-encode it, and sample again for a
    few steps at low denoise. Everything the second pass needs already exists
    in our template except the concat, so this reuses the SAME guider — hers
    has two `BasicGuider` nodes and both read one model and one conditioning,
    so the second is decoration. (Her turbo LoRA node is wired to neither: her
    published two-pass is base H3 at 15+4 steps, not a distilled one. Worth
    knowing before quoting her step counts as a turbo recipe.)

    Where this differs, and why, is the audio — see
    `worker/comfy_nodes/neon_h3_refine`. Hers re-encodes a waveform because she
    then overwrites it with the user's locked track; ours carries pass 1's
    audio latent straight across and freezes it.

    Raises rather than falling back to one pass. A refine that silently does
    not happen is the exact silent downgrade this codebase keeps naming: the
    job would succeed, cost the same as it always did, and the take would be
    indistinguishable from an unrefined one except by looking at it.
    """
    sampler = next((nid for nid, n in g.items()
                    if n.get("class_type") == "SamplerCustomAdvanced"), None)
    guider = next((nid for nid, n in g.items()
                   if n.get("class_type") in ("BasicGuider", "CFGGuider")), None)
    ksel = next((nid for nid, n in g.items()
                 if n.get("class_type") in ("KSamplerSelect",
                                            "MiniMaxH3TurboSampler")), None)
    sched = next((nid for nid, n in g.items()
                  if n.get("class_type") == "BasicScheduler"), None)
    vdec = next((nid for nid, n in g.items()
                 if n.get("class_type") == "VAEDecode"), None)
    if not (sampler and guider and ksel and sched and vdec):
        raise ResolveError(
            f"model '{model}' asks for a refine pass but its workflow has no "
            f"single-pass sampler chain to build one from")
    vae = g[vdec]["inputs"].get("vae")
    if not _islink(vae):
        raise ResolveError(f"model '{model}' refine pass cannot find the video VAE")
    # The model the SECOND scheduler reads has to be the one the first reads —
    # on H3 the sigmas come off BasicScheduler, so a refine pass built against
    # the unpatched loader would sample a turbo graph on the stock schedule.
    model_link = g[sched]["inputs"].get("model")

    scale = float(spec["scale"])
    rw, rh = _snap32(width * scale), _snap32(height * scale)
    nid = [max((int(k) for k in g if k.isdigit()), default=0)]

    def add(node):
        nid[0] += 1
        g[str(nid[0])] = node
        return str(nid[0])

    mid = add({"class_type": "VAEDecode",
               "inputs": {"samples": [sampler, 0], "vae": vae}})
    up = add({"class_type": "ImageScale", "inputs": {
        "image": [mid, 0], "upscale_method": spec["upscale_method"],
        "width": rw, "height": rh, "crop": "disabled"}})
    enc = add({"class_type": "VAEEncode",
               "inputs": {"pixels": [up, 0], "vae": vae}})
    cat = add({"class_type": "NeonH3RefineLatent", "inputs": {
        "av_latent": [sampler, 0], "video_latent": [enc, 0],
        "freeze_audio": bool(spec["freeze_audio"])}})
    sig = add({"class_type": "BasicScheduler", "inputs": {
        "model": model_link, "scheduler": spec["scheduler"],
        "steps": int(spec["steps"]), "denoise": float(spec["denoise"])}})
    noise = add({"class_type": "RandomNoise",
                 "inputs": {"noise_seed": (int(seed) + 1) % (2 ** 32)}})
    pass2 = add({"class_type": "SamplerCustomAdvanced", "inputs": {
        "noise": [noise, 0], "guider": [guider, 0], "sampler": [ksel, 0],
        "sigmas": [sig, 0], "latent_image": [cat, 0]}})

    # Every consumer of pass 1's latent now reads pass 2's — except the ones
    # this function just built (they are what turns one into the other) and
    # EXCEPT THE AUDIO DECODE, which deliberately keeps reading pass 1.
    #
    # That exception is the whole audio story, and `freeze_audio` alone is not
    # it. Measured: with the audio decoded from the refined latent, a 4.5s
    # block's soundtrack came back at 0.937 correlation and 8.9 dB SNR against
    # the take it refines — audibly a different render, not a re-encode
    # artifact. Re-reading vrgamedevgirl's own AudioDrive node explains why:
    # its zero mask exists so the VIDEO conditions on unperturbed audio, and
    # she then MUXES THE ORIGINAL WAVEFORM back in ("the VAE round-trip is only
    # for model conditioning"). Nothing in the mask promises the sampled audio
    # half survives untouched.
    #
    # We have no user-supplied track to re-impose, but we do have the exact
    # equivalent: pass 1's own audio. Decoding it from pass 1 makes "the
    # refined take sounds identical to the take it refines" true BY
    # CONSTRUCTION rather than by hoping a mask holds — and it is strictly
    # cheaper, since the audio VAE runs on the smaller latent either way.
    audio_decoders = {nid for nid, n in g.items()
                      if n.get("class_type") in ("VAEDecodeAudio", "LTXVAudioVAEDecode")}
    built = {mid, cat, pass2}
    for onid, onode in g.items():
        if onid in built or onid in audio_decoders:
            continue
        for k, v in onode.get("inputs", {}).items():
            if _islink(v) and v[0] == sampler:
                onode["inputs"][k] = [pass2, 0]
    _log(f"refine pass: {width}x{height} -> {rw}x{rh}, {spec['steps']} steps "
         f"@ denoise {spec['denoise']}"
         f"{'' if spec['freeze_audio'] else ', audio re-sampled'}")
    return pass2


LATENT_UPSCALE_DEFAULTS = {
    "model": "minimax_h3_latent_upscaler_3d_bf16.safetensors",
    # The first pass renders at this many megapixels (aspect kept, /32) and
    # the upscaler carries the latent to the requested size. 0.35 MP is
    # 736x416 on 16:9 — the Seed Hunter's own "preview" tier, a quarter of the
    # 1280x736 default's pixels, so the pass that decides composition and
    # motion costs a quarter of the sampling.
    "first_pass_mp": 0.35,
    # The LAST fraction of the schedule re-sampled at full size, on the same
    # trained sigmas (SplitSigmasDenoise takes the tail of whatever the model
    # chain emits — BasicScheduler's, or PDD's block boundaries). 0.45 is
    # heavier than refine's 0.2 because the upscaled latent is a learned
    # guess at detail that never existed, and lighter than the Seed Hunter's
    # sigma-0.90 restart, which is close to a second render.
    "denoise": 0.45,
    "precision": "fp16",
    "align": 32,
}


def latent_upscale_spec(m, want):
    """The latent-upscale recipe for this model+job -> dict, or None.

    Same contract as `refine_spec`: False/None is off, True takes the model's
    recipe, a dict overrides individual keys, and a model with no
    `latent_upscale` block declines regardless.
    """
    if not want:
        return None
    base = m.get("latent_upscale")
    if not base:
        return None
    spec = {**LATENT_UPSCALE_DEFAULTS, **base}
    if isinstance(want, dict):
        spec.update({k: v for k, v in want.items() if v is not None})
    return spec


def first_pass_dims(width, height, spec):
    """The first pass's (w, h) for a latent-upscaled render: `first_pass_mp`
    megapixels at the target's aspect, snapped to /32, never larger than the
    target. Pure."""
    mp = float(spec.get("first_pass_mp") or LATENT_UPSCALE_DEFAULTS["first_pass_mp"])
    scale = (mp * 1_000_000 / float(width * height)) ** 0.5
    if scale >= 1.0:
        return int(width), int(height)
    return min(int(width), _snap32(width * scale)), min(int(height), _snap32(height * scale))


def _splice_h3_latent_upscale(g, model, spec, *, width, height, seed):
    """Upscale pass 1's VIDEO latent in place and re-sample the schedule's
    tail at the target size — the Seed Hunter workflow's second half
    (civitai 2881362), adapted to this graph's shape.

    This is the THIRD second pass and it is not either of the other two.
    `refine` decodes, upscales PIXELS, re-encodes and re-noises: a resolution
    play through a 5B VAE round trip. `split_pass` continues one trajectory at
    reduced adapter strength with no resize at all. This one resizes the
    LATENT with a learned 24-channel upscaler (LBH-123-AI's 3D-conv model —
    no decode, no encode, none of the ghosting bilinear interpolation gives)
    and then re-samples the LAST `denoise` of the model's OWN schedule on the
    bigger latent. It composes with every model chain because it never
    touches the chain: `SplitSigmasDenoise` takes the tail of whatever sigmas
    the sampler was already reading — BasicScheduler's on plain/turbo H3,
    the PDD node's trained block boundaries on `minimax-h3-pdd`, where every
    other second pass is refused because they invent sigmas off the grid.

    The wiring follows the reference workflow exactly where it matters:
    `LTXVSeparateAVLatent` splits the nested AV latent, the video half goes
    through the upscaler, `LTXVConcatAVLatent` puts pass 1's AUDIO half back
    beside it, and pass 2 samples that. Two deliberate departures:

      * THE AUDIO IS DECODED FROM PASS 1, not pass 2 — refine's rule, for
        refine's measured reason: re-noising the audio latent and sampling it
        again produced a soundtrack below the two-identical-renders floor.
        Nothing in the picture depends on it, and pass 1's audio is the
        completed trajectory for that stream.
      * NO SECOND GUIDE. The reference workflow rebuilds its MiniMaxH3AddGuide
        pins against the upscaled latent because its continuation frames are
        in-latent. Ours (motion context) are dropped by `resolve()` when this
        pass is on — see the note there — so pass 2 reads the SAME guider and
        conditioning as pass 1 (references are conditioning tokens with their
        own RoPE; they do not care what size the latent is).

    Every consumer of pass 1's latent is rewired to pass 2 — VAEDecode, the
    context-save node, anything a later splice added — except the audio
    decoders and the nodes built here. Raises rather than degrading: a
    latent-upscale that silently did not happen returns a 0.35 MP render
    that upscaled itself in the player, and nothing would say so.
    """
    sampler = next((nid for nid, n in g.items()
                    if n.get("class_type") == "SamplerCustomAdvanced"), None)
    guider = next((nid for nid, n in g.items()
                   if n.get("class_type") in ("BasicGuider", "CFGGuider")), None)
    ksel = next((nid for nid, n in g.items()
                 if n.get("class_type") in ("KSamplerSelect",
                                            "MiniMaxH3TurboSampler")), None)
    if not (sampler and guider and ksel):
        raise ResolveError(
            f"model '{model}' asks for a latent-upscale pass but its workflow "
            f"has no single-pass sampler chain to build one from")
    sig_src = g[sampler]["inputs"].get("sigmas")
    if not _islink(sig_src):
        raise ResolveError(f"model '{model}' latent-upscale pass cannot find the sigmas "
                           f"feeding the sampler")
    nid = [max((int(k) for k in g if k.isdigit()), default=0)]

    def add(node):
        nid[0] += 1
        g[str(nid[0])] = node
        return str(nid[0])

    sep = add({"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": [sampler, 0]}})
    up = add({"class_type": "MinimaxH3LatentUpscaler3D", "inputs": {
        "latent": [sep, 0], "model_name": spec["model"],
        # The node's V3 dynamic combo is named `mode` (read off the pod's
        # /object_info, not the README's "resize mode"), and its per-option
        # inputs are NAMESPACED under it — `mode.width`, not `width`. Verified
        # by submitting the bare spelling to the live engine: it was refused
        # with `required_input_missing: mode.width`. The same trap SenseNova's
        # `reference_images.image2` documents, one pack over.
        "mode": "target dimensions",
        "mode.width": int(width), "mode.height": int(height),
        "align": int(spec.get("align", 32)),
        "enable_temporal_chunking": True, "force_unload": True,
        "device": "cuda", "precision": spec.get("precision", "fp16")}})
    cat = add({"class_type": "LTXVConcatAVLatent",
               "inputs": {"video_latent": [up, 0], "audio_latent": [sep, 1]}})
    split = add({"class_type": "SplitSigmasDenoise",
                 "inputs": {"sigmas": sig_src, "denoise": float(spec["denoise"])}})
    noise = add({"class_type": "RandomNoise",
                 "inputs": {"noise_seed": (int(seed) + 1) % (2 ** 32)}})
    pass2 = add({"class_type": "SamplerCustomAdvanced", "inputs": {
        "noise": [noise, 0], "guider": [guider, 0], "sampler": [ksel, 0],
        "sigmas": [split, 1], "latent_image": [cat, 0]}})
    audio_decoders = {nid_ for nid_, n in g.items()
                      if n.get("class_type") in ("VAEDecodeAudio", "LTXVAudioVAEDecode")}
    built = {sep, up, cat, split, noise, pass2}
    for onid, onode in g.items():
        if onid in built or onid in audio_decoders:
            continue
        for k, v in onode.get("inputs", {}).items():
            if _islink(v) and v[0] == sampler:
                onode["inputs"][k] = [pass2, 0]
    _log(f"latent upscale: -> {width}x{height} via {spec['model']}, tail "
         f"{float(spec['denoise']):.0%} of the schedule re-sampled at full size, "
         f"audio from pass 1")
    return pass2


SPLIT_PASS_DEFAULTS = {
    # ExtendIntermediateSigmas: insert N extra sigmas between two values, so
    # the schedule gets more resolution exactly where motion is decided.
    "extend_steps": 3, "extend_from": 0.65, "extend_to": 0.28,
    "spacing": "sine",
    # SplitSigmasDenoise: the LAST `split` fraction of the schedule is stage 2.
    "split": 0.25,
    # Stage 2 re-applies the same adapters at reduced strength. Two scales
    # because the author reduces them by different amounts: concept/style
    # 1.0 -> 0.65, and the distillation 0.7 -> 0.2.
    "lora_scale": 0.65, "turbo_scale": 0.29,
}


def split_pass_spec(m, want):
    """The low-sigma second-pass recipe for this model+job -> dict, or None.

    Same contract as `refine_spec`: False/None is off, True takes the model's
    recipe, a dict overrides individual keys, and a model with no `split_pass`
    block declines regardless.
    """
    if not want:
        return None
    base = m.get("split_pass")
    if not base:
        return None
    spec = {**SPLIT_PASS_DEFAULTS, **base}
    if isinstance(want, dict):
        spec.update({k: v for k, v in want.items() if v is not None})
    return spec


def _model_chain(g, head):
    """Walk a MODEL link back to the loader, returning [adapters…] nearest-last.

    The chain is loader -> adapter -> adapter -> consumer, built by repeated
    `_splice_model_node` calls. Returns (loader_id, [adapter ids from the one
    nearest the loader outward]).
    """
    chain, seen = [], set()
    cur = head
    while _islink(cur) and cur[0] not in seen:
        nid = cur[0]
        seen.add(nid)
        node = g.get(nid) or {}
        if node.get("class_type") in MODEL_LOADERS:
            return nid, list(reversed(chain))
        chain.append(nid)
        cur = node.get("inputs", {}).get("model")
    return None, list(reversed(chain))


# The strength key differs by adapter class, and scaling the wrong one is a
# silent no-op: the node keeps its default and stage 2 runs at full strength.
_STRENGTH_KEYS = ("strength_model", "strength")


def _splice_h3_split_pass(g, model, spec):
    """Split ONE denoise schedule in two and run the tail at reduced LoRA strength.

    This is NOT `_splice_h3_refine` with different numbers, and the difference
    is the reason both exist. Refine decodes, UPSCALES the picture, re-encodes
    and re-noises: a resolution play that produces a second, different render.
    This splits a single sigma schedule with `SplitSigmasDenoise`, and stage 2
    continues stage 1's own latent with `DisableNoise` — no new noise, no
    decode, no resize. One trajectory, sampled in two halves.

    What it buys is the ability to run the two halves on DIFFERENT model
    chains. A combat/motion adapter at full strength decides the movement while
    sigma is high, then stage 2 finishes the same latent with that adapter
    turned down, so it stops smearing detail into the low-sigma tail. Combat
    Base V2's author warns in as many words that high weights cost H3 its own
    fluidity — "sped-up motion, blur, endless attacks without proper recovery"
    — and this is the shape that answers it without giving up the motion.

    Adapted from the author's own `Universal FL2VA/REF2VA Base Model +
    Low-Sigma Combat Second-Pass` workflow (civitai 2869434). Their numbers are
    tuned against Combat V1 and a lightx2v turbo at 0.7; ours default to the
    same RATIOS. Every node it needs is core ComfyUI — the one node in their
    graph we do not have is a SageAttention memory patch, which exists to fit
    12GB and is meaningless on this box.

    THE AUDIO COMES FROM STAGE 2, unlike refine. There the audio deliberately
    keeps reading pass 1, because pass 2 is a re-noised second render and its
    audio measured BELOW the two-identical-renders floor. Here there is no
    re-noise: stage 2 is the same denoise continuing, so its latent is the
    completed trajectory for BOTH streams and reading audio off stage 1 would
    be decoding a half-denoised waveform. The author's own graph wires
    VAEDecode and VAEDecodeAudio to the second sampler for exactly this reason.
    """
    sampler = next((nid for nid, n in g.items()
                    if n.get("class_type") == "SamplerCustomAdvanced"), None)
    guider = next((nid for nid, n in g.items()
                   if n.get("class_type") in ("BasicGuider", "CFGGuider")), None)
    ksel = next((nid for nid, n in g.items()
                 if n.get("class_type") in ("KSamplerSelect",
                                            "MiniMaxH3TurboSampler")), None)
    sched = next((nid for nid, n in g.items()
                  if n.get("class_type") == "BasicScheduler"), None)
    if not (sampler and guider and ksel and sched):
        raise ResolveError(
            f"model '{model}' asks for a low-sigma second pass but its "
            f"workflow has no single-pass sampler chain to split")

    nid = [max((int(k) for k in g if k.isdigit()), default=0)]

    def add(node):
        nid[0] += 1
        g[str(nid[0])] = node
        return str(nid[0])

    # 1. Extend the schedule, then split it. Both hang off BasicScheduler, so
    #    they inherit whatever patched the MODEL chain — which is why this
    #    function must run after every model splice, the same ordering rule
    #    refine follows and for the same reason (H3's sigmas come off
    #    BasicScheduler, so a pass built earlier samples a distilled model on
    #    the stock schedule).
    ext = add({"class_type": "ExtendIntermediateSigmas", "inputs": {
        "sigmas": [sched, 0], "steps": int(spec["extend_steps"]),
        "start_at_sigma": float(spec["extend_from"]),
        "end_at_sigma": float(spec["extend_to"]),
        "spacing": spec["spacing"]}})
    split = add({"class_type": "SplitSigmasDenoise", "inputs": {
        "sigmas": [ext, 0], "denoise": float(spec["split"])}})
    # Stage 1 takes the HIGH sigmas (slot 0); stage 2 the low ones (slot 1).
    g[sampler]["inputs"]["sigmas"] = [split, 0]

    # 2. Rebuild the model chain for stage 2 at reduced strength. Duplicating
    #    the adapter nodes (rather than mutating them) is what lets the two
    #    stages differ at all — they share the loader and nothing else.
    loader, adapters = _model_chain(g, g[guider]["inputs"].get("model"))
    if loader is None:
        raise ResolveError(
            f"model '{model}' second pass cannot find the model loader behind "
            f"its guider")
    link = [loader, 0]
    scaled = []
    for aid in adapters:
        src = g[aid]
        ins = dict(src.get("inputs") or {})
        key = next((k for k in _STRENGTH_KEYS if k in ins), None)
        is_turbo = "Turbo" in (src.get("class_type") or "")
        scale = float(spec["turbo_scale"] if is_turbo else spec["lora_scale"])
        if key is not None:
            ins[key] = round(float(ins[key]) * scale, 4)
            scaled.append(f"{ins.get('lora_name', src.get('class_type'))}"
                          f"@{ins[key]}")
        ins["model"] = link
        link = [add({"class_type": src["class_type"], "inputs": ins}), 0]
    if not adapters:
        _log("split pass: no adapters on the MODEL chain, so both stages run "
             "the same weights — the extended schedule still applies, but the "
             "strength reduction this pass exists for does nothing")

    # 3. Stage 2: same conditioning, same sampler object, no fresh noise.
    g2 = add({"class_type": g[guider]["class_type"], "inputs": {
        **{k: v for k, v in g[guider].get("inputs", {}).items()},
        "model": link}})
    quiet = add({"class_type": "DisableNoise", "inputs": {}})
    pass2 = add({"class_type": "SamplerCustomAdvanced", "inputs": {
        "noise": [quiet, 0], "guider": [g2, 0], "sampler": [ksel, 0],
        "sigmas": [split, 1], "latent_image": [sampler, 0]}})

    # 4. Every consumer of stage 1 now reads stage 2 — the AUDIO DECODE
    #    INCLUDED. See the docstring: this is the documented difference from
    #    refine, and getting it backwards decodes a half-denoised waveform.
    # The stage-1 sampler keeps its own output link (stage 2 reads it as
    # `latent_image`); the nodes this function built are already wired.
    skip = {ext, split, g2, quiet, pass2}
    for onid, onode in g.items():
        if onid in skip or onid == sampler:
            continue
        for k, v in onode.get("inputs", {}).items():
            if _islink(v) and v[0] == sampler:
                onode["inputs"][k] = [pass2, 0]
    _log(f"split pass: +{spec['extend_steps']} sigmas "
         f"{spec['extend_from']}->{spec['extend_to']} ({spec['spacing']}), "
         f"tail {spec['split']:.0%} on "
         f"{', '.join(scaled) if scaled else 'the same weights'}")
    return pass2


def _splice_model_node(g, model, node):
    """Insert `node` into the MODEL chain directly after the checkpoint loader.

    Every node that read the loader's MODEL output is rewired to read `node`
    instead, so the insert is transparent to the rest of the graph — that
    matters for H3, where BOTH the guider and the scheduler take the model and
    patching only one silently samples off an unpatched schedule.

    Splicing at the loader (rather than at the head of whatever chain is
    already there) means repeated calls stack: the most recently spliced node
    sits nearest the loader and the earlier ones downstream of it. Adapter
    order is not meaningful for the independent adapters here.
    """
    loader_id = next((nid for nid, n in g.items()
                      if n.get("class_type") in MODEL_LOADERS), None)
    if loader_id is None:
        raise ResolveError(f"model '{model}' needs a {node['class_type']} spliced in "
                           f"but its workflow has no model loader")
    nid = str(max((int(k) for k in g if k.isdigit()), default=0) + 1)
    node.setdefault("inputs", {})["model"] = [loader_id, 0]
    g[nid] = node
    for onid, onode in g.items():
        if onid == nid:
            continue
        for k, v in onode.get("inputs", {}).items():
            if _islink(v) and v[0] == loader_id:
                onode["inputs"][k] = [nid, 0]
    return nid


def resolve(model, mode, *, positive, negative, seed, width, height, length,
            steps=None, cfg=None, source_image=None, end_image=None,
            ref_images=None, ref_videos=None, ref_audios=None, mm=None,
            exact_frames=None, workflow=None, source_audio=None,
            motion_ctx=None, context_save=None, loras=None,
            ref_background=None, refine=None, split_pass=None,
            latent_upscale=None):
    """exact_frames: bypass the legacy Wan-unit conversion and render exactly
    this many frames (block jobs pre-compute 17n+5 counts in h3_timing).
    workflow: override the mode's template (e.g. minimax_h3_r2v_audiolock.json).
    source_audio: staged filename for the audiolock template's LoadAudio node.
    motion_ctx: {"video": staged filename, "context_length": frames,
    "skip_frames": n} — splice ComfyUI-H3-Motion-Context between the H3 latent
    builder's conditioning and the guider, so a chained block continues the
    previous take's motion and audio instead of re-deciding from a still. The
    caller checks the node pack is installed; here a graph without the H3
    builder is a hard error (the flag was passed somewhere it can't work).
    context_save: {"prefix": filename_prefix} — persist this H3 render's AV
    latent (MiniMaxH3MotionContextSaveLatent) so the next chained block can
    take its motion context losslessly from the latent instead of the mp4.
    loras: the job's LoRA picks as KEYS — ["combat", {"key": "handheld",
    "strength": 0.8}] — mapped through this model's `style_loras` and spliced on
    top of any baked-in `style_lora`. See `lora_stack`.
    refine: True (the model's own recipe) or a dict of overrides — add a
    second, higher-resolution sampler pass. Orthogonal to checkpoint, style and
    turbo, which is exactly why it is a parameter here and not six more
    model_map entries. Only H3 declares a recipe today; see `_splice_h3_refine`.
    latent_upscale: True (the model's recipe) or a dict of overrides — render
    the FIRST pass small, upscale the latent with a learned resizer and
    re-sample the schedule's tail at the requested size. The one second pass
    that works on `minimax-h3-pdd`. See `_splice_h3_latent_upscale`."""
    mm = mm or load_map()
    tier = mm[TIER]
    if model not in tier["models"]:
        raise ResolveError(f"model '{model}' not available on tier '{TIER}'")
    m = tier["models"][model]
    modes = m.get("modes", {})
    if mode not in modes:
        raise ResolveError(f"mode '{mode}' not available for {model} on tier '{TIER}' "
                           f"(have: {', '.join(modes)})")
    mode_spec = modes[mode]

    wf_name = workflow or mode_spec.get("workflow")
    wf_path = os.path.join(WORKFLOWS_DIR, wf_name)
    if not os.path.exists(wf_path):
        raise ResolveError(f"workflow template missing: {wf_name}")
    with open(wf_path) as f:
        g = json.load(f)
    if g.get("_stub"):
        raise ResolveError(f"workflow '{wf_name}' is a stub — capture the real graph "
                           f"on the runpod tier (see template comment) before using {model}/{mode}")
    g = {k: v for k, v in g.items() if not k.startswith("_")}  # drop _comment keys

    ensure_model(model, mm)

    enc = (m.get("text_encoders") or [None])[0]
    encs = m.get("text_encoders") or []
    vae = m.get("vae") if isinstance(m.get("vae"), str) else None
    audio_vae = m.get("audio_vae") if isinstance(m.get("audio_vae"), str) else None

    # Per-model style trigger (e.g. the LTX anime LoRAs): prepend once.
    trig = m.get("trigger")
    if trig and trig.lower() not in (positive or "").lower():
        positive = f"{trig}, {positive}" if positive else trig

    # The app expresses `length` in Wan frames (16fps, 16n+1). Models with an
    # `fps` key get the count converted to the same wall-clock duration at their
    # native rate, then snapped to that model's legal frame count:
    #   frame_base/frame_rem => length % base == rem
    #   LTX 2.3   : 24fps, 8n+1  (base 8,  rem 1) — the previous hardcoded rule
    #   MiniMax H3: 24fps, 17n+5 (base 17, rem 5) — per ComfyUI's own template
    # Some models patchify the latent in 2x2 blocks, so the frame size must be
    # divisible by (VAE stride x patch) — 32 for MiniMax H3. 1280x720 is the
    # trap: 720/16 = 45 latent rows, odd, and the sampler dies with
    # "shape [...22, 2, 40, 2] is invalid for input of size 86400". Snap here so
    # a UI preset that suits Wan can't produce an unrenderable graph.
    step = int(m.get("dim_step", 0) or 0)
    if step:
        sw, sh = width, height
        width = max(step, int(round(width / step)) * step)
        height = max(step, int(round(height / step)) * step)
        if (sw, sh) != (width, height):
            print(f"[resolve] snapped {sw}x{sh} -> {width}x{height} (step {step})", flush=True)

    fps = m.get("fps")
    if exact_frames is not None:
        # Block jobs carry a pre-planned legal frame count — trust it.
        length = int(exact_frames)
    elif fps:
        seconds = max(1, int(length) - 1) / 16.0
        base = int(m.get("frame_base", 8))
        rem = int(m.get("frame_rem", 1))
        n = max(rem, int(round(seconds * fps)))
        length = n + (rem - n) % base

    # LTX 2.5's official pipeline renders its BASE pass at reduced resolution
    # and doubles it with the latent spatial upscaler, so the one empty video
    # latent in those templates wants scaled dims — snapped to /32 exactly the
    # way the source implementation does. With `dim_step` 64 on the entry the
    # 2x round-trip lands back on the requested size, so no resize node is
    # needed after decode. Entries without `latent_scale` are untouched.
    lscale = float(m.get("latent_scale") or 1)
    if lscale != 1:
        lat_w = max(64, int(round(width * lscale / 32.0)) * 32)
        lat_h = max(64, int(round(height * lscale / 32.0)) * 32)
    else:
        lat_w, lat_h = int(width), int(height)
    # A latent-upscaled render samples its FIRST pass small: the H3 builder's
    # width/height (the latent it makes) shrink here, and the pass spliced in
    # at the end carries the latent back to `width`x`height`. Decided before
    # the node loop so nothing below has to know — the same seam LTX 2.5's
    # `latent_scale` uses.
    lu_spec = latent_upscale_spec(m, latent_upscale)
    if latent_upscale and not lu_spec:
        raise ResolveError(
            f"model '{model}' was asked for a latent-upscale pass but declares "
            f"no `latent_upscale` recipe — there is no upscaler to name")
    if lu_spec:
        if refine or split_pass:
            raise ResolveError(
                f"model '{model}': `latent_upscale` is a second pass of its own "
                f"and does not stack with `refine` or `split_pass`")
        if lscale != 1:
            raise ResolveError(
                f"model '{model}' already samples at a reduced latent scale; "
                f"latent_upscale is for the families that render full size")
        lat_w, lat_h = first_pass_dims(width, height, lu_spec)
        if (lat_w, lat_h) != (int(width), int(height)):
            print(f"[resolve] latent upscale: first pass {lat_w}x{lat_h} -> "
                  f"{width}x{height}", flush=True)
        if motion_ctx:
            # The pinned frames are in-latent guides sized to the FIRST pass,
            # and pass 2 samples a bigger latent under the same conditioning
            # — the reference workflow rebuilds its guides per pass for this
            # reason. Not rebuilt here (untested against the MotionContext
            # node's own encode), so the chain falls back to the frame anchor
            # the caller already staged as <Picture 1>. Said out loud: it is
            # the one thing this pass costs a chained block.
            print("[resolve] latent upscale: motion context dropped (its guides "
                  "are sized to the first pass) — the chain keeps its frame "
                  "anchor", flush=True)
            motion_ctx = None

    # which CLIPTextEncode nodes are wired as positive / negative anywhere
    pos_src, neg_src = set(), set()
    for node in g.values():
        for key, val in node.get("inputs", {}).items():
            if _islink(val):
                if key == "positive":
                    pos_src.add(val[0])
                elif key == "negative":
                    neg_src.add(val[0])

    # which LoadImage feeds start vs end (MiniMax H3 names them first/last_frame)
    start_load = end_load = None
    for node in g.values():
        ins = node.get("inputs", {})
        for k in ("start_image", "first_frame"):
            if _islink(ins.get(k)):
                start_load = ins[k][0]
        for k in ("end_image", "last_frame"):
            if _islink(ins.get(k)):
                end_load = ins[k][0]
        # LTX 2.5 PINS ITS FRAMES BY INDEX, not by input name. Core's
        # `LTXVAddGuide` calls its picture `image` whatever end of the clip it
        # is going on, and says which end in `frame_idx` — 0 for the first
        # frame, negative for the last. So the names above find NEITHER, and
        # the fallback below ("anything else gets the source image") would put
        # the START frame into both guides of an flf render: a first-and-last
        # graph that quietly renders the same picture at both ends.
        if node.get("class_type") == "LTXVAddGuide" and _islink(ins.get("image")):
            if int(ins.get("frame_idx", 0)) < 0:
                end_load = ins["image"][0]
            else:
                start_load = ins["image"][0]

    for nid, node in g.items():
        ct = node.get("class_type")
        ins = node.setdefault("inputs", {})
        if ct == "UNETLoader":
            cur = str(ins.get("unet_name", ""))
            if "high" in cur and mode_spec.get("high"):
                ins["unet_name"] = mode_spec["high"]
            elif "low" in cur and mode_spec.get("low"):
                ins["unet_name"] = mode_spec["low"]
            elif mode_spec.get("checkpoint"):
                ins["unet_name"] = mode_spec["checkpoint"]
        elif ct in ("UnetLoaderGGUF", "UnetLoaderGGUFAdvanced"):
            if "high" in str(ins.get("unet_name", "")) and mode_spec.get("high"):
                ins["unet_name"] = mode_spec["high"]
            elif mode_spec.get("low"):
                ins["unet_name"] = mode_spec["low"]
            # A SINGLE-CHECKPOINT GGUF ENTRY, which this branch could not
            # express until the desktop grew quantised H3. Only Wan had a GGUF
            # template and Wan is a high/low PAIR, so the two clauses above were
            # the whole world — and an entry naming one `checkpoint` left the
            # TEMPLATE'S literal filename in place. That is the worst shape a
            # bug can take here: the graph validates, the render succeeds, and
            # it silently used whichever file the template happened to ship
            # with. Mirrors the `UNETLoader` branch directly above.
            elif mode_spec.get("checkpoint"):
                ins["unet_name"] = mode_spec["checkpoint"]
        elif ct == "CLIPLoader" and enc:
            ins["clip_name"] = enc
        elif ct == "DualCLIPLoader" and len(encs) >= 2:
            ins["clip_name1"], ins["clip_name2"] = encs[0], encs[1]
        elif ct == "VAELoader":
            # LTX templates carry two VAELoaders; the audio one must not be
            # clobbered with the video file. Match on the template's filename.
            if "audio" in str(ins.get("vae_name", "")).lower():
                if audio_vae:
                    ins["vae_name"] = audio_vae
            elif vae:
                ins["vae_name"] = vae
        elif ct == "LoraLoaderModelOnly":
            # Style-LoRA slots in the *_style templates carry a STYLE placeholder;
            # the lightning-distill loaders keep the filename they ship with.
            if "STYLE" in str(ins.get("lora_name", "")):
                if not m.get("style_lora"):
                    raise ResolveError(f"model '{model}' uses a style-LoRA workflow "
                                       f"but has no 'style_lora' in model_map")
                ins["lora_name"] = m["style_lora"]
                ins["strength_model"] = float(m.get("style_strength", 1.0))
        elif ct == "LTX2LoraLoaderAdvanced":
            if not m.get("lora"):
                raise ResolveError(f"model '{model}' uses an LTX LoRA workflow but has no 'lora' in model_map")
            ins["lora_name"] = m["lora"]
            ins["strength_model"] = float(m.get("lora_strength", 1.0))
        elif ct == "LatentUpscaleModelLoader" and m.get("latent_upscaler"):
            ins["model_name"] = m["latent_upscaler"]
        elif ct == "ComfyUILTX25MSRICLoRALoader":
            # The MSR IC-LoRA is not decoration on this graph — it carries the
            # learned reference-slot embeddings the guide node reads, so a
            # template that has the node and a map without the file is a
            # misconfiguration, not a fallback case.
            if not m.get("msr_lora"):
                raise ResolveError(f"model '{model}' uses an MSR reference workflow "
                                   f"but has no 'msr_lora' in model_map")
            ins["lora_name"] = m["msr_lora"]
            ins["strength_model"] = float(m.get("msr_strength", 1.0))
        elif ct == "CLIPTextEncode":
            if nid in pos_src:
                ins["text"] = positive
            elif nid in neg_src:
                ins["text"] = negative
        elif ct in LATENT_CLASSES:
            if "width" in ins:
                ins["width"] = lat_w
            if "height" in ins:
                ins["height"] = lat_h
            if "length" in ins:
                ins["length"] = int(length)
            # H3 carries the prompt itself — no CLIPTextEncode in the graph.
            if ct in PROMPT_INPUT_CLASSES and "prompt" in ins:
                ins["prompt"] = positive
        elif ct == "KSampler":
            ins["seed"] = int(seed)
            if steps is not None:
                ins["steps"] = int(steps)
            if cfg is not None:
                ins["cfg"] = float(cfg)
        elif ct == "KSamplerAdvanced":
            ins["noise_seed"] = int(seed)
            if steps is not None:
                ins["steps"] = int(steps)
            if cfg is not None:
                ins["cfg"] = float(cfg)
        elif ct == "BasicScheduler":
            # H3 samples through BasicGuider/BasicScheduler, not KSampler, so
            # until now NOTHING set its step count: the caller's `steps` was
            # accepted and dropped, and every H3 render used the template's
            # literal 20. That is exactly the knob a turbo model has to turn
            # (its whole point is 6), hence model_map `steps` as the fallback.
            # Verified before enabling: no generation_blocks row carries a
            # steps override, so honouring the argument changes no existing
            # episode — plain H3 declares no `steps` and keeps its 20.
            want = steps if steps is not None else m.get("steps")
            if want is not None:
                ins["steps"] = int(want)
            if m.get("scheduler"):
                ins["scheduler"] = m["scheduler"]
        elif ct == "KSamplerSelect" and m.get("sampler"):
            # A distillation can rewrite which SAMPLER the schedule wants, not
            # only how many steps. lightx2v's H3 turbo is documented at er_sde;
            # the Larryvrh one replaces this node outright (below) and never
            # reaches here.
            ins["sampler_name"] = m["sampler"]
        elif ct == "RandomNoise":
            ins["noise_seed"] = int(seed)
        elif ct == "ImageScale":
            # i2v templates that pre-fit the source still to the output frame
            ins["width"], ins["height"] = int(width), int(height)
        elif ct == "LTXVEmptyLatentAudio":
            ins["frames_number"] = int(length)
            if fps:
                ins["frame_rate"] = int(fps)
        elif ct == "LTXVConditioning" and fps:
            ins["frame_rate"] = float(fps)
        elif ct == "CreateVideo" and fps:
            ins["fps"] = float(fps)
        elif ct == "LoadImage":
            if nid == start_load and source_image:
                ins["image"] = source_image
            elif nid == end_load and end_image:
                ins["image"] = end_image
            elif source_image:
                ins["image"] = source_image
        elif ct == "LoadAudio" and source_audio:
            # audiolock template stages the block's pre-sliced wav here
            if "AUDIO_SLICE" in str(ins.get("audio", "")):
                ins["audio"] = source_audio

    # A style_lora whose workflow template ships no LoraLoaderModelOnly
    # placeholder (every MiniMax H3 template — unlike the Wan/LTX *_style
    # templates, which carry one) gets one spliced in here: after the model
    # loader, ahead of every node that consumed its MODEL output. This is what
    # lets a style variant reuse H3's existing i2v/t2v/flf templates instead
    # of needing a hand-edited duplicate of each.
    if m.get("style_lora") and not any(
            n.get("class_type") == "LoraLoaderModelOnly" for n in g.values()):
        _splice_model_node(g, model, {"class_type": "LoraLoaderModelOnly", "inputs": {
            "lora_name": m["style_lora"],
            "strength_model": float(m.get("style_strength", 1.0)),
        }})

    # The job's own LoRA picks, stacked on top of whatever the entry bakes in.
    #
    # ORDER MATTERS and this block must stay BELOW the style_lora block above:
    # that one's guard is "does this template already ship a LoraLoaderModelOnly
    # placeholder" (Wan/LTX *_style templates do, H3's don't). Splicing our nodes
    # first would satisfy that test and silently drop the baked-in style LoRA,
    # so a style variant would quietly render as the plain checkpoint.
    #
    # A picked-but-missing file RAISES rather than rendering without it.
    # `ensure_model` can't cover these — they are optional, so listing them as
    # "needed" would demand all five on every H3 render — but quietly dropping
    # one the user explicitly asked for is the silent-downgrade failure this
    # codebase keeps getting bitten by: a clip that ignores the pick, no error,
    # nothing to grep. The presence check is skipped when the loras directory
    # isn't there at all, so off-pod graph tests still build.
    lora_dir = os.path.join(COMFY_ROOT, "models", "loras")
    for fn, strength in lora_stack(m, loras):
        p = os.path.join(lora_dir, fn)
        if os.path.isdir(lora_dir) and not (os.path.exists(p) or os.path.islink(p)):
            raise ResolveError(
                f"model '{model}' was asked for lora '{fn}' but it is not on "
                f"{lora_dir} — run `bash the engine window's model list h3-loras` "
                f"(or the target that ships it) on the pod")
        _splice_model_node(g, model, {"class_type": "LoraLoaderModelOnly", "inputs": {
            "lora_name": fn,
            "strength_model": float(strength),
        }})

    # A turbo_lora is a STEP DISTILLATION, not a style, and it needs two things
    # a plain LoRA does not.
    #
    # 1. Its own loader. MiniMaxH3TurboLoRA applies the adapter as a runtime
    #    bypass rather than merging it into the weights — on a quantized base
    #    (ours is int8_convrot) merging rounds part of the delta away, which is
    #    precisely the signal that makes 6 steps work. LoraLoaderModelOnly would
    #    load the file and quietly give back a softer model.
    # 2. Its own sampler. The distillation rewrites the noise schedule, and H3
    #    decodes video AND audio from one latent, so MiniMaxH3TurboSampler is
    #    what keeps the audio stream coherent at low step counts. Swapping it in
    #    for KSamplerSelect keeps the node id, so SamplerCustomAdvanced's
    #    existing `sampler` link needs no rewiring.
    #
    # Both nodes come from Larryvrh/ComfyUI-MiniMax-H3-Turbo. If the pack is
    # missing ComfyUI rejects the graph outright — which is the behaviour we
    # want over silently rendering 6 steps on the stock schedule.
    #
    # NOT every H3 distillation works that way, though, and assuming so would
    # make the pack a dependency of distillations that never needed it.
    # lightx2v's 4-step is an ordinary adapter its own docs apply with a plain
    # LoraLoaderModelOnly; what it rewrites is the SAMPLER (er_sde) and the step
    # count, which `sampler`/`steps` already carry. `turbo_apply` picks, and it
    # defaults to "bypass" so every entry written before this is unchanged.
    if m.get("turbo_lora"):
        if (m.get("turbo_apply") or "bypass") == "plain":
            _splice_model_node(g, model, {
                "class_type": "LoraLoaderModelOnly", "inputs": {
                    "lora_name": m["turbo_lora"],
                    "strength_model": float(m.get("turbo_strength", 1.0)),
                }})
        else:
            _splice_model_node(g, model, {"class_type": "MiniMaxH3TurboLoRA", "inputs": {
                "lora_name": m["turbo_lora"],
                "strength": float(m.get("turbo_strength", 1.0)),
                # bypass, not merge — see (1). The node's own default, stated here
                # because on this box it is a correctness choice, not a tuning one.
                "low_vram": False,
            }})
            sampler_ids = [nid for nid, n in g.items()
                           if n.get("class_type") == "KSamplerSelect"]
            if not sampler_ids:
                raise ResolveError(f"model '{model}' declares a turbo_lora but workflow "
                                   f"'{wf_name}' has no KSamplerSelect to replace")
            for nid in sampler_ids:
                g[nid] = {"class_type": "MiniMaxH3TurboSampler", "inputs": {}}

    # PDD — Parallel Decoding Distillation, the official alibaba-pai 8-step
    # acceleration (`pdd` in model_map), and a THIRD apply shape beside
    # `bypass` and `plain` because these files are not ordinary LoRAs: beside
    # a rank-64 trunk LoRA they carry a per-interval HEAD BANK for
    # final_layer that a plain loader silently drops — and on our PRUNED
    # int8_convrot checkpoints a plain loader additionally spams ~50
    # `ERROR lora ... adaln_proj` lines and loses that part of the distill
    # (the pack rebases those modules onto the pruned model's curve table).
    # MiniMaxH3PDDAccApply (Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc) loads
    # the whole thing and EMITS ITS OWN SIGMAS: the trained block boundaries.
    # So BasicScheduler stops being the schedule — SamplerCustomAdvanced is
    # rewired to the node's sigmas output — and the sampler must be plain
    # euler (each step consumes one mean block velocity; a multi-stage
    # sampler evaluates the trunk off the trained grid and the node fails
    # closed rather than rendering noise). The file follows the CHECKPOINT:
    # fl2va for i2v/t2v/flf, ref2va for r2v — the two trunks ship identical
    # key sets, so a crossed pairing applies cleanly and renders silently
    # wrong; the node fingerprints the trunk and errors on a mismatch.
    if m.get("pdd"):
        if m.get("turbo_lora"):
            raise ResolveError(
                f"model '{model}' declares both `pdd` and `turbo_lora` — "
                f"distillations don't stack; keep exactly one")
        pdd = m["pdd"]
        ckpt_kind = "ref2va" if mode == "r2v" else "fl2va"
        pdd_file = pdd.get(ckpt_kind)
        if not pdd_file:
            raise ResolveError(
                f"model '{model}' declares no PDD file for its {ckpt_kind} "
                f"checkpoint (mode '{mode}')")
        pid = _splice_model_node(g, model, {
            "class_type": "MiniMaxH3PDDAccApply", "inputs": {
                "pdd_file": pdd_file,
                # the node's combo takes the count as a STRING
                "nfe": str(pdd.get("nfe", "8")),
                "lora_strength": float(pdd.get("lora_strength", 1.0)),
                "head_strength": float(pdd.get("head_strength", 1.0)),
                # refuse off-grid evaluation outright — `clamp` exists for
                # experiments and degrades the output silently
                "on_off_grid": "error",
            }})
        wired = False
        for n in g.values():
            if n.get("class_type") == "SamplerCustomAdvanced":
                n["inputs"]["sigmas"] = [pid, 1]
                wired = True
        if not wired:
            raise ResolveError(
                f"model '{model}' declares `pdd` but workflow '{wf_name}' has "
                f"no SamplerCustomAdvanced to hand the trained sigmas to")
        for n in g.values():
            if n.get("class_type") == "KSamplerSelect":
                n["inputs"]["sampler_name"] = "euler"

    # Wan 2.2 is a two-expert MoE: high-noise makes the motion, low-noise the
    # detail. Patching a LoRA onto fp8_scaled weights makes ComfyUI hold a bf16
    # copy of every patched layer, so styling BOTH experts roughly doubles 14GB
    # of weights — measured to OOM the second sampler at 480p/65f on the 46GB
    # L40S. Default to the low-noise (detail) pass, where surface style lives;
    # style_experts="both" in model_map opts back in for short clips.
    if m.get("style_lora") and m.get("style_experts", "low") == "low":
        high_ld = {nid for nid, n in g.items()
                   if n.get("class_type") == "UNETLoader"
                   and n.get("inputs", {}).get("unet_name") == mode_spec.get("high")}
        for nid, node in list(g.items()):
            ins = node.get("inputs", {})
            if (node.get("class_type") == "LoraLoaderModelOnly"
                    and ins.get("lora_name") == m["style_lora"]
                    and _islink(ins.get("model")) and ins["model"][0] in high_ld):
                src = list(ins["model"])
                for other in g.values():          # rewire consumers past it
                    for k, v in other.get("inputs", {}).items():
                        if _islink(v) and v[0] == nid:
                            other["inputs"][k] = src
                del g[nid]

    # R2V: swap the template's single placeholder ref slot for the shot's refs.
    if any(n.get("class_type") == "MiniMaxH3ReferenceToVideo" for n in g.values()):
        if not (ref_images or ref_videos or ref_audios):
            raise ResolveError("reference-to-video needs at least one reference — link a "
                               "bible entry or attach an image/video/audio on the shot")
        _wire_refs(g, images=ref_images, videos=ref_videos, audios=ref_audios,
                   render_dims=(width, height), render_frames=length)
    if any(n.get("class_type") == "ComfyUILTX25MSRMultiReferenceGuide" for n in g.values()):
        if not (ref_images or ref_background):
            raise ResolveError("LTX MSR reference-to-video needs at least one reference "
                               "image — pic1 is a required input on the guide")
        _wire_msr_refs(g, images=ref_images, background=ref_background)

    if motion_ctx:
        _wire_motion_context(g, motion_ctx)
    if context_save:
        _wire_context_save(g, context_save)

    # A second pass, LAST — after every model splice, so the refine scheduler
    # picks up whatever patched the MODEL chain (turbo especially: H3's sigmas
    # come off BasicScheduler, so a refine built before the turbo splice would
    # sample the distilled model on the stock schedule). Same ordering rule the
    # LoRA stack follows for the opposite reason.
    # The LOW-SIGMA second pass, same ordering rule as refine below and for
    # the same reason. They are alternatives, not a stack: refine re-noises an
    # upscaled latent while this one continues the original denoise, so running
    # both would upscale-and-re-noise a trajectory that was already finished
    # under a different model chain. Untested, and it would cost three passes,
    # so it is refused rather than guessed at.
    sspec = split_pass_spec(m, split_pass)
    if split_pass and not sspec:
        raise ResolveError(
            f"model '{model}' was asked for a low-sigma second pass but "
            f"declares no `split_pass` recipe — there is nothing to say where "
            f"to split the schedule or how far to turn the adapters down")
    if sspec and refine:
        raise ResolveError(
            f"model '{model}': `split_pass` and `refine` are alternative "
            f"second passes — pick one. refine re-noises an upscaled latent; "
            f"split_pass continues the original denoise at reduced adapter "
            f"strength")
    if sspec:
        if not any(n.get("class_type", "").startswith("MiniMaxH3") for n in g.values()):
            raise ResolveError(
                f"split_pass is implemented for MiniMax H3 only; '{model}' "
                f"mode '{mode}' builds no H3 graph")
        _splice_h3_split_pass(g, model, sspec)

    rspec = refine_spec(m, refine)
    if refine and not rspec:
        raise ResolveError(
            f"model '{model}' was asked for a refine pass but declares no "
            f"`refine` recipe — a pass with no steps or scale to sample is a "
            f"render that costs more and changes nothing")
    if rspec:
        if not any(n.get("class_type", "").startswith("MiniMaxH3") for n in g.values()):
            raise ResolveError(
                f"refine is implemented for MiniMax H3 only; '{model}' mode "
                f"'{mode}' builds no H3 graph")
        _splice_h3_refine(g, model, rspec, width=width, height=height, seed=seed)

    # The LATENT-UPSCALE pass, last of all and after every model splice: it
    # splits the sigmas the sampler is reading at this point, which on a
    # PDD row is the apply node's own trained grid and on a turbo row the
    # patched scheduler's — a split built earlier would be of the stock
    # schedule. Refused beside refine/split_pass above.
    if lu_spec:
        if not any(n.get("class_type", "").startswith("MiniMaxH3") for n in g.values()):
            raise ResolveError(
                f"latent_upscale is implemented for MiniMax H3 only; '{model}' "
                f"mode '{mode}' builds no H3 graph")
        _splice_h3_latent_upscale(g, model, lu_spec, width=width, height=height, seed=seed)

    outputs = [nid for nid, n in g.items() if n.get("class_type") in ("SaveVideo", "SaveAnimatedWEBP", "SaveWEBM")]
    if not outputs:
        raise ResolveError(f"workflow '{wf_name}' has no save node")
    return {"graph": g, "outputs": outputs, "workflow": wf_name}


if __name__ == "__main__":
    import sys
    model = sys.argv[1] if len(sys.argv) > 1 else "wan2.2"
    mode = sys.argv[2] if len(sys.argv) > 2 else "t2v"
    out = resolve(model, mode, positive="a neon city at night", negative="blurry",
                  seed=42, width=512, height=288, length=13, steps=4)
    print(json.dumps(out["graph"], indent=2))
    print("outputs:", out["outputs"], "workflow:", out["workflow"])

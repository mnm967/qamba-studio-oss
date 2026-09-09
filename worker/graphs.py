"""ComfyUI graph builders for the local image models (Flux 1/Kontext,
Flux 2, Klein 9B, Krea 2) — moved verbatim from the v1 worker.py.

LoRAs are a STACK, not a slot. A checkpoint finetune plus a concept LoRA plus a
style LoRA is the ordinary case, and every builder used to take exactly one
`style_lora` — so asking for two silently kept the first.
`_lora_chain` wires however many the caller passes, in order, and returns the
MODEL link the rest of the graph should read.
"""


def _unet_loader(fn, weight_dtype="default"):
    """The loader that can actually open this file.

    THE LOADER FOLLOWS THE FILE, NOT THE FAMILY. A `.gguf` needs city96's
    `UnetLoaderGGUF` and a `.safetensors` needs the stock `UNETLoader`, and
    which one a model_map entry names is a decision the map makes — either by
    hand, or by `resolve.apply_rungs` pointing the entry at whichever precision
    rung this machine actually downloaded. A builder that hardcodes one is a
    builder that fails at load with nothing but a node error the moment the map
    names the other, which is what `flux2_ref_graph`'s own comment has said
    since it was the only one that branched.

    `weight_dtype` is dropped on the GGUF branch because that node does not
    declare it — `_fit_node_inputs` would drop it anyway, but silently, and an
    input that quietly disappears is the kind of thing this file writes down.

    NOT EVERY LOADER CAN DO THIS. `hidream_o1_graph` reads a single all-in-one
    checkpoint through `CheckpointLoaderSimple`, and city96's pack registers no
    checkpoint loader at all (UnetLoaderGGUF, CLIPLoaderGGUF, DualCLIPLoaderGGUF,
    TripleCLIPLoaderGGUF, QuadrupleCLIPLoaderGGUF and nothing else) — so HiDream
    has no GGUF form to branch to, and both of its catalog rungs are safetensors
    anyway.
    """
    if str(fn).lower().endswith(".gguf"):
        return {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": fn}}
    return {"class_type": "UNETLoader",
            "inputs": {"unet_name": fn, "weight_dtype": weight_dtype}}


def _norm_loras(loras=None, style_lora=None, lora_strength=None, default_strength=1.0):
    """Normalise the callers' two shapes into [(filename, strength), …].

    Accepts the new `loras` list — of "name.safetensors", ("name", 0.8) or
    {"name":…, "strength":…} — and the old single `style_lora` + `lora_strength`
    pair, which every existing call site still uses.
    """
    out = []
    for item in (loras or []):
        if not item:
            continue
        if isinstance(item, str):
            name, strength = item, default_strength
        elif isinstance(item, (list, tuple)):
            name = item[0]
            strength = item[1] if len(item) > 1 and item[1] is not None else default_strength
        else:
            name = item.get("name") or item.get("file") or item.get("lora")
            strength = item.get("strength", item.get("weight", default_strength))
        if name:
            out.append((name, float(strength if strength is not None else default_strength)))
    if style_lora:
        s = lora_strength if lora_strength is not None else default_strength
        out.append((style_lora, float(s)))
    # A file listed twice would be applied twice at compounding strength.
    seen, uniq = set(), []
    for name, strength in out:
        if name in seen:
            continue
        seen.add(name)
        uniq.append((name, strength))
    return uniq


def _fit_node_inputs(inputs, spec):
    """Reshape a node's inputs to the schema the INSTALLED node actually has.

    Custom nodes are not versioned against our graphs. `Krea2EditRebalance` is
    the live example: the workflow this builder came from (Civitai 2757982) was
    authored against a build with a `negative` STRING input and no sampler
    controls, while today's Rebalance-Pack requires `steering`,
    `layer_multiplier` and `enable_step` and has dropped `negative` entirely.
    Sending the old shape at the new node fails validation on the missing
    required inputs — the job dies before it renders, which reads as "the
    reference model is broken" rather than "the node moved on".

    `spec` is the node's entry from ComfyUI /object_info. Unknown keys are
    dropped; required keys we did not supply are filled from their declared
    defaults (first option for a COMBO). spec=None keeps the caller's shape, so
    graph construction stays testable without a running ComfyUI.
    """
    if not spec:
        return inputs
    decl = (spec.get("input") or {})
    required = decl.get("required") or {}
    known = set(required) | set(decl.get("optional") or {})
    out = {k: v for k, v in inputs.items() if k in known}
    for key, sig in required.items():
        if key in out:
            continue
        kind = sig[0] if isinstance(sig, (list, tuple)) and sig else None
        opts = sig[1] if isinstance(sig, (list, tuple)) and len(sig) > 1 and isinstance(sig[1], dict) else {}
        if "default" in opts:
            out[key] = opts["default"]
        elif isinstance(kind, list) and kind:          # COMBO: first choice
            out[key] = kind[0]
        elif kind == "STRING":
            out[key] = ""
        elif kind in ("INT", "FLOAT"):
            out[key] = 0
        elif kind == "BOOLEAN":
            out[key] = True
        # a missing required LINK input (CLIP/IMAGE/...) is a caller bug, not
        # something a default can paper over — leave it out and let it raise.
    return out


def _lora_chain(g, model_src, loras, first_id=900):
    """Chain LoraLoaderModelOnly nodes onto `model_src`; return the new link.

    Model-only: these graphs condition through Qwen3-VL / Flux 2 encoders that
    the CLIP side of a LoraLoader would not touch anyway, and a CLIP patch on a
    text encoder the LoRA was not trained against is how you get garbage
    conditioning rather than a style.
    """
    nid = first_id
    for name, strength in loras:
        g[str(nid)] = {"class_type": "LoraLoaderModelOnly",
                       "inputs": {"model": model_src, "lora_name": name,
                                  "strength_model": float(strength)}}
        model_src = [str(nid), 0]
        nid += 1
    return model_src


def flux_ref_graph(fm, prompt, seed, width, height, style_lora=None, style_strength=0.9,
                   loras=None):
    """API graph for a reference still on the aws box: flux.1-dev fp8 UNET +
    T5 on CPU (verified 18.3GB peak on the L4) + a LoRA stack.

    Flux 1 LoRAs are usually trained with a CLIP side, so the FIRST one goes
    through a full LoraLoader and its patched CLIP feeds the encoder. Anything
    stacked on top is model-only: patching clip_l repeatedly with adapters
    trained against different text sides is how conditioning goes to mush.
    """
    neg = "blurry, low quality, watermark, text, jpeg artifacts"
    stack = _norm_loras(loras, style_lora, style_strength, style_strength)
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": fm["unet"], "weight_dtype": fm.get("weight_dtype", "fp8_e4m3fn")}},
        "2": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": fm["t5"], "clip_name2": fm["clip_l"], "type": "flux", "device": "cpu"}},
        "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}},
        "7": {"class_type": "EmptySD3LatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "8": {"class_type": "KSampler", "inputs": {"model": ["6", 0], "seed": int(seed), "steps": 20, "cfg": 1.0,
              "sampler_name": "euler", "scheduler": "simple", "positive": ["4", 0], "negative": ["5", 0],
              "latent_image": ["7", 0], "denoise": 1.0}},
        "9": {"class_type": "VAELoader", "inputs": {"vae_name": fm["vae"]}},
        "10": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["9", 0]}},
        "11": {"class_type": "SaveImage", "inputs": {"images": ["10", 0], "filename_prefix": "qamba/ref"}},
    }
    model_src, clip_src = ["1", 0], ["2", 0]
    if stack:
        name, strength = stack[0]
        g["3"] = {"class_type": "LoraLoader", "inputs": {"model": ["1", 0], "clip": ["2", 0],
                  "lora_name": name, "strength_model": float(strength), "strength_clip": 1.0}}
        model_src, clip_src = ["3", 0], ["3", 1]
        model_src = _lora_chain(g, model_src, stack[1:])
    g["6"] = {"class_type": "ModelSamplingFlux",
              "inputs": {"model": model_src, "max_shift": 1.15, "base_shift": 0.5,
                         "width": width, "height": height}}
    g["4"] = {"class_type": "CLIPTextEncodeFlux",
              "inputs": {"clip": clip_src, "clip_l": prompt, "t5xxl": prompt, "guidance": 3.5}}
    _ = neg  # negative handled via ConditioningZeroOut (flux cfg 1.0)
    return g


def flux2_ref_graph(f2, prompt, seed, width, height, steps=20, refs=None):
    """FLUX.2-dev (32B) via GGUF Q4_K_M. Flux 2 uses its own latent format and
    sigma schedule, so it goes through EmptyFlux2LatentImage + Flux2Scheduler +
    SamplerCustomAdvanced rather than the plain KSampler path Flux 1 uses. Its
    text encoder is Mistral-3-small (CLIPLoader type "flux2"), not clip_l/T5.
    Guidance is baked in, so the guider runs at cfg 1.0 with a zeroed negative.

    It DOES take references, and for a long time this builder didn't wire them:
    the name said `ref` while the signature had no `refs`, so a job that staged
    a reference set rendered a text-to-image over it — no error, just a picture
    that ignored its input. The fix at the time was to route those jobs away to
    Klein. But Klein and Flux 2 dev are the SAME architecture, and Klein's
    builder already conditions on references the Flux 2 way: one VAEEncode per
    image, then a ReferenceLatent chained onto BOTH the positive and negative
    conditioning. That chain is reused verbatim here. Four references is the
    published ceiling for dev; the prompt addresses them positionally
    ("Figure 1", "Figure 2", …), which is Flux 2's convention and NOT the
    "reference 1 is X's face sheet" phrasing the Krea 2 and Qwen paths use.
    """
    g = {
        # The loader follows the FILE — see `_unet_loader`, which this builder's
        # own comment used to be the only statement of.
        "1": _unet_loader(f2["unet"]),
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": f2["text_encoder"], "type": "flux2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": f2["vae"]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}},
        "6": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": int(width), "height": int(height), "batch_size": 1}},
        "7": {"class_type": "Flux2Scheduler", "inputs": {"steps": int(steps), "width": int(width), "height": int(height)}},
        "8": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "9": {"class_type": "RandomNoise", "inputs": {"noise_seed": int(seed)}},
    }
    pos, neg = ["4", 0], ["5", 0]
    for i, img in enumerate((refs or [])[:4]):
        ld, sc, enc = f"3{i}0", f"3{i}1", f"3{i}2"
        g[ld] = {"class_type": "LoadImage", "inputs": {"image": img}}
        g[sc] = {"class_type": "ImageScaleToTotalPixels",
                 "inputs": {"image": [ld, 0], "upscale_method": "lanczos",
                            "megapixels": 1.0, "resolution_steps": 1}}
        g[enc] = {"class_type": "VAEEncode", "inputs": {"pixels": [sc, 0], "vae": ["3", 0]}}
        rp, rn = f"3{i}3", f"3{i}4"
        g[rp] = {"class_type": "ReferenceLatent", "inputs": {"conditioning": pos, "latent": [enc, 0]}}
        g[rn] = {"class_type": "ReferenceLatent", "inputs": {"conditioning": neg, "latent": [enc, 0]}}
        pos, neg = [rp, 0], [rn, 0]
    g["10"] = {"class_type": "CFGGuider", "inputs": {"model": ["1", 0], "positive": pos, "negative": neg, "cfg": 1.0}}
    g["11"] = {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["9", 0], "guider": ["10", 0], "sampler": ["8", 0], "sigmas": ["7", 0], "latent_image": ["6", 0]}}
    g["12"] = {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}}
    g["13"] = {"class_type": "SaveImage", "inputs": {"images": ["12", 0], "filename_prefix": "qamba/ref_flux2"}}
    return g


def krea2_graph(k2, prompt, seed, width, height, style_lora=None, steps=None, cfg=None,
                lora_strength=None, loras=None):
    """Krea 2 turbo (13.1GB fp8) text->image, and every Krea 2 checkpoint
    finetune that shares its architecture.

    Distilled turbo model: 8 steps at cfg 1.0, euler/simple — the settings the
    Civitai workflow (2738703) documents. Sampler/scheduler/steps come from the
    model_map entry, so a finetune with a recipe of its own (several ship a
    different step count on the beta scheduler) does not need a second builder. Its text encoder is
    Qwen3-VL-4B loaded through CLIPLoader with type "krea2", and it decodes
    through the Qwen image VAE, not a Flux one.

    There is no separate negative prompt: cfg 1.0 means the negative branch is
    never evaluated, and the reference workflow feeds a ConditioningZeroOut of
    the positive encode rather than a second CLIPTextEncode. Mirrored here so
    the graph matches the recipe the model was tuned against.
    """
    steps = int(steps or k2.get("steps", 8))
    cfg = float(cfg if cfg is not None else k2.get("cfg", 1.0))
    stack = _norm_loras(loras, style_lora, lora_strength, k2.get("lora_strength", 1.0))
    g = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": k2["unet"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": k2["text_encoder"], "type": "krea2",
                         "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": k2["vae"]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}},
        "6": {"class_type": "EmptySD3LatentImage",
              "inputs": {"width": int(width), "height": int(height), "batch_size": 1}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage",
              "inputs": {"images": ["8", 0], "filename_prefix": "neon/krea2"}},
    }
    model_out = _lora_chain(g, ["1", 0], stack)
    g["7"] = {"class_type": "KSampler",
              "inputs": {"model": model_out, "seed": int(seed), "steps": steps, "cfg": cfg,
                         "sampler_name": k2.get("sampler", "euler"),
                         "scheduler": k2.get("scheduler", "simple"),
                         "positive": ["4", 0], "negative": ["5", 0],
                         "latent_image": ["6", 0], "denoise": 1.0}}
    return g


def _splice_krea2_control(g, model_out, latent, *, control_image, lora,
                          strength, ctrl_spec=None, enc_spec=None,
                          preprocess=None, pre_spec=None):
    """Attach a depth (or other) control map to a Krea 2 model.

    Three nodes from facok/comfyui-krea2-controlnet, in this order: the LoRA
    loader (block weights + an expanded input projection), a VAE encode of the
    control map, and an Apply that converts the encoded latent into Krea 2's
    latent space and hangs it on the MODEL. Apply is mandatory — the LoRA
    alone loads and does nothing.

    It rides on the MODEL rather than on conditioning, which is the entire
    reason it is interesting here: a storyboard panel spends image1/image2 on
    face sheets (the high token budget) and the location plate loses to them,
    so control through the reference set is control the faces can outvote.
    This channel they cannot.

    `latent` is passed to the encoder so `match_latent_size` resizes the map to
    what is actually being sampled; without it a control map of a different
    aspect silently stretches.

    `preprocess` makes the control map INSIDE the graph, which is the whole
    point of doing it here: callers hand over the location's master plate — an
    ordinary registered asset they already stage — and never have to produce,
    store or register a depth map. A pre-made map is still accepted by passing
    preprocess=None.
    """
    src = [_CTRL_IMG, 0]
    if preprocess:
        g["48"] = {"class_type": preprocess,
                   "inputs": _fit_node_inputs(
                       {"image": [_CTRL_IMG, 0], "resolution": 1024}, pre_spec)}
        src = ["48", 0]
    enc = {"control_image": src, "vae": ["3", 0],
           "resize": "match_latent_size", "upscale_method": "lanczos",
           "crop": "center",
           # The author's stated starting point for a Depth Anything map.
           "channel_mode": "grayscale", "normalize": "per_image_minmax",
           "invert": False, "batch_mode": "independent_images",
           "latent": latent}
    g[_CTRL_IMG] = {"class_type": "LoadImage",
                    "inputs": {"image": control_image, "upload": "image"}}
    g["50"] = {"class_type": "Krea2ControlLoRALoader",
               "inputs": _fit_node_inputs(
                   {"model": model_out, "lora_name": lora,
                    "strength": float(strength)}, ctrl_spec)}
    g["51"] = {"class_type": "Krea2ControlImageEncode",
               "inputs": _fit_node_inputs(enc, enc_spec)}
    g["52"] = {"class_type": "Krea2ControlApply",
               "inputs": {"model": ["50", 0], "control_latent": ["51", 0]}}
    return ["52", 0]


_CTRL_IMG = "49"


def krea2_ref_graph(k2, prompt, seed, width, height, refs, *, negative="",
                    steps=None, style_lora=None, lora_strength=None, tokens=None,
                    loras=None, node_spec=None, source_image=None, denoise=1.0,
                    control_image=None, control_lora=None, control_strength=1.0,
                    control_spec=None, control_enc_spec=None,
                    control_preprocess=None, control_pre_spec=None):
    """Krea 2 with up to four reference images — the API-format equivalent of
    the "Krea2 Multi-Reference Image Editing" workflow (Civitai 2757982).

    Krea2 has no ReferenceLatent path, but the community Krea2EditRebalance
    node conditions the same turbo checkpoint on image1..image4 through the
    Qwen3-VL encoder, with a per-image token budget. That budget is the whole
    point: image1 carries "high" and the rest "normal", so the first reference
    dominates identity while the others contribute context. We stage the face
    first everywhere, which lines up exactly.

    Sampling follows the workflow rather than krea2_graph's KSampler: a
    BasicGuider + SamplerCustomAdvanced chain, euler/simple, 8 steps, denoise 1
    — the settings the distilled turbo model was tuned for. The source workflow
    has no LoRA loader at all; the stack below is the deliberate addition, wired
    where the workflow's UNETLoader output goes so BOTH the guider and the
    scheduler read the patched model (a BasicScheduler on the unpatched model
    silently computes sigmas for different weights).

    `source_image` turns this into a real EDIT rather than a composition, and
    the distinction is the whole difference between "add more neon" changing
    your picture and returning a different one. Rebalance is a *conditioning*
    node: it describes the references into the Qwen3-VL stream and touches no
    latent, so on an empty latent at denoise 1.0 the sampler starts from pure
    noise and the source's pixels are nowhere in the graph — a new image that
    merely resembles what was described. Encoding the source into the starting
    latent and stopping the schedule short (`denoise` < 1) is what keeps the
    frame: layout, pose and background survive, and only what the prompt asks
    for moves. The source stays image1 as well, so it conditions *and* seeds.
    Size then comes from the source image, not from width/height — an edit that
    reframes is not an edit.

    Requires the Krea2EditRebalance custom node; callers check for it via
    comfy.object_info() and fall back to a ref-capable model when absent.
    """
    steps = int(steps or k2.get("steps", 8))
    tokens = tokens or ["high", "normal", "normal", "normal"]
    denoise = float(denoise if denoise is not None else 1.0)
    stack = _norm_loras(loras, style_lora, lora_strength, k2.get("lora_strength", 1.0))
    g = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": k2["unet"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": k2["text_encoder"], "type": "krea2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": k2["vae"]}},
        "10": {"class_type": "RandomNoise", "inputs": {"noise_seed": int(seed)}},
        "11": {"class_type": "KSamplerSelect",
               "inputs": {"sampler_name": k2.get("sampler", "euler")}},
    }
    if source_image:
        g["40"] = {"class_type": "LoadImage", "inputs": {"image": source_image}}
        g["41"] = {"class_type": "VAEEncode",
                   "inputs": {"pixels": ["40", 0], "vae": ["3", 0]}}
        latent = ["41", 0]
    else:
        g["12"] = {"class_type": "EmptyLatentImage",
                   "inputs": {"width": int(width), "height": int(height), "batch_size": 1}}
        latent = ["12", 0]
        denoise = 1.0        # nothing to preserve; a partial schedule on noise
                             # would just render an unfinished image
    if denoise < 1.0:
        # BasicScheduler builds `steps` sigmas and keeps only the last `denoise`
        # fraction of them, so a partial denoise SPENDS fewer steps than it
        # asks for. On an 8-step distilled model that is 4 steps at 0.5 — the
        # edit comes back soft and reads as the model being bad at edits. Ask
        # for enough that the run keeps the recipe's tuned step count.
        steps = max(steps, int(round(steps / max(denoise, 0.05))))
    model_out = _lora_chain(g, ["1", 0], stack)
    if control_image and control_lora:
        model_out = _splice_krea2_control(
            g, model_out, latent, control_image=control_image,
            lora=control_lora, strength=control_strength,
            ctrl_spec=control_spec, enc_spec=control_enc_spec,
            preprocess=control_preprocess, pre_spec=control_pre_spec)

    reb = {"clip": ["2", 0], "text": prompt, "negative": negative}
    for i, name in enumerate(refs[:4]):
        node = str(20 + i)
        g[node] = {"class_type": "LoadImage", "inputs": {"image": name, "upload": "image"}}
        reb[f"image{i + 1}"] = [node, 0]
        reb[f"image{i + 1}_tokens"] = tokens[i] if i < len(tokens) else "normal"
    g["30"] = {"class_type": "Krea2EditRebalance",
               "inputs": _fit_node_inputs(reb, node_spec)}

    g["31"] = {"class_type": "BasicGuider",
               "inputs": {"model": model_out, "conditioning": ["30", 0]}}
    # BasicScheduler's own `denoise` trims the sigma schedule — the correct way
    # to do partial denoise on the SamplerCustomAdvanced path, where there is no
    # KSampler `denoise` input to set.
    g["32"] = {"class_type": "BasicScheduler",
               "inputs": {"model": model_out, "scheduler": k2.get("scheduler", "simple"),
                          "steps": steps, "denoise": denoise}}
    g["33"] = {"class_type": "SamplerCustomAdvanced",
               "inputs": {"noise": ["10", 0], "guider": ["31", 0], "sampler": ["11", 0],
                          "sigmas": ["32", 0], "latent_image": latent}}
    g["34"] = {"class_type": "VAEDecode", "inputs": {"samples": ["33", 0], "vae": ["3", 0]}}
    g["35"] = {"class_type": "SaveImage",
               "inputs": {"images": ["34", 0], "filename_prefix": "neon/krea2ref"}}
    return g


def flux2_klein_graph(km, prompt, seed, width, height, refs=None, steps=50, cfg=4.0,
                      loras=None):
    """FLUX.2-klein-base-9B (18.2GB bf16) + its Shinkai LoRA.

    Klein *base* is not distilled, so it wants real guidance — euler, 1MP —
    unlike distilled Klein (4 steps, cfg 1). The defaults here are 50 steps at
    cfg 4.0 and THAT PAIRING IS SUSPECT: community guidance pairs cfg 3.5-5.0
    with 20-24 steps, or cfg 1.0 with 20-30, and 50-at-4.0 is off both bands.
    Rendered live on one panel, three ways: 50/4.0 came back with radioactive
    green tiles, hard black outlines and posterised flat light — the classic
    over-guidance signature; 24/4.0 was the same look, milder; 24/1.0 was
    atmospheric and painterly but loose enough to duplicate a character and
    typeset a character's NAME onto the wall as graffiti. So low cfg buys the
    look and loses the contract. `payload.steps`/`payload.cfg` override the
    map (handlers.images) so this can be tuned without a redeploy — do that
    before trusting Klein for anything the identity has to survive.

    This is the only local model that takes MULTIPLE reference images: Flux 2
    conditions on them by chaining a ReferenceLatent per image onto BOTH the
    positive and negative conditioning, and the prompt addresses them
    positionally ("Figure 1", "Figure 2", …).
    """
    refs = refs or []
    # No implicit style. Klein used to carry a bare `lora` + `trigger` in its
    # map entry and apply BOTH unconditionally: every generation was wrapped in
    # the Shinkai LoRA at strength 1.0 with "anime screencap" prepended, with
    # nothing in the UI saying so and no way to turn it off — so asking Klein
    # for a photoreal shot returned anime, and every multi-ref job that fell
    # back to Klein was silently restyled. Both now travel as ordinary
    # style_loras keys the caller selects (handlers.images resolves the key to
    # a file and prepends the trigger only for LoRAs actually in the stack).
    text = prompt
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": km["unet"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": km["text_encoder"], "type": "flux2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": km["vae"]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": text}},
        "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}},
        "6": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": int(width), "height": int(height), "batch_size": 1}},
        "7": {"class_type": "Flux2Scheduler", "inputs": {"steps": int(steps), "width": int(width), "height": int(height)}},
        "8": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "9": {"class_type": "RandomNoise", "inputs": {"noise_seed": int(seed)}},
    }
    model_src = _lora_chain(
        g, ["1", 0],
        _norm_loras(loras, default_strength=km.get("lora_strength", 1.0)))

    pos, neg = ["4", 0], ["5", 0]
    for i, img in enumerate(refs[:6]):          # Flux 2 handles several refs
        ld, sc, enc = f"3{i}0", f"3{i}1", f"3{i}2"
        g[ld] = {"class_type": "LoadImage", "inputs": {"image": img}}
        g[sc] = {"class_type": "ImageScaleToTotalPixels",
                 "inputs": {"image": [ld, 0], "upscale_method": "lanczos",
                            "megapixels": 1.0, "resolution_steps": 1}}
        g[enc] = {"class_type": "VAEEncode", "inputs": {"pixels": [sc, 0], "vae": ["3", 0]}}
        rp, rn = f"3{i}3", f"3{i}4"
        g[rp] = {"class_type": "ReferenceLatent", "inputs": {"conditioning": pos, "latent": [enc, 0]}}
        g[rn] = {"class_type": "ReferenceLatent", "inputs": {"conditioning": neg, "latent": [enc, 0]}}
        pos, neg = [rp, 0], [rn, 0]

    g["10"] = {"class_type": "CFGGuider", "inputs": {"model": model_src, "positive": pos, "negative": neg, "cfg": float(cfg)}}
    g["11"] = {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["9", 0], "guider": ["10", 0], "sampler": ["8", 0], "sigmas": ["7", 0], "latent_image": ["6", 0]}}
    g["12"] = {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}}
    g["13"] = {"class_type": "SaveImage", "inputs": {"images": ["12", 0], "filename_prefix": "neon/klein"}}
    return g


# MiniMax H3's natively-accepted frame sizes, from the Simple Image Edit
# workflow's own notes (Civitai 2833301), normalised long-side-first — the list
# is published landscape bar one portrait example, and H3 renders either
# orientation. Anything else is rescaled by the model itself: it still renders,
# it just costs a little quality, so this is a preference and not a constraint.
#
# The published list says 824x1024. Every other entry is a multiple of 32, as a
# latent model requires, and 832 already appears as a native short side (1504x832)
# — so that is read here as a typo for 832x1024.
H3_NATIVE_DIMS = [
    (608, 352), (736, 416), (864, 480), (960, 544), (1056, 608), (1152, 640),
    (1216, 672), (1280, 736), (1344, 768), (1376, 768), (1504, 832),
    (1664, 928), (1920, 1088), (1024, 832),
]


AR_TOLERANCE = 0.02      # how far a native size may differ in aspect and still win

# Shortest clip the STOCK H3 nodes will accept. The published workflow asks for
# `length: 1`, and MiniMaxH3ImageToVideo/ReferenceToVideo reject that outright
# as shipped — the input declares `min: 5, step: 17`, i.e. exactly the 17n+5
# grid from invariant #5, so 5 is n=0. We then keep only the first decoded
# frame; this is four extra frames of sampler time, not four extra images.
H3_IMAGE_FRAMES = 5


def h3_image_node(refs=None, source_image=None):
    """The H3 node an image job of this shape will run on.

    Public because the caller has to probe the INSTALLED node (below) before
    the graph is built, and re-deriving "which node is this?" at the call site
    is how the two drift apart — the checkpoint follows the node, so getting it
    wrong picks the wrong weights as well as the wrong schema.
    """
    return "MiniMaxH3ReferenceToVideo" if (refs and not source_image) \
        else "MiniMaxH3ImageToVideo"


def h3_image_frames(node_spec=None, h3=None):
    """How many frames to render for ONE image: 1 when that is fully supported.

    Rendering five and keeping frame 0 is not merely wasteful, it is the reason
    H3 stills come out soft: the video VAE decodes a temporal window, so frame 0
    of a five-frame clip carries motion-blur the model invented to get to frame
    1. `image_vae` (the T1 single-frame decoder) fixes that — but ONLY at
    length 1. Feed it five frames and take the first and it returns grid
    artifacts instead, which is worse than the blur it was replacing. So the
    frame count and the decoder are ONE decision, and it is made here: both
    halves have to be in place or neither is used.

    Both halves are probed rather than assumed. ComfyUI's stock declaration is
    `min: 5, step: 17`; the engine window's H3 single-frame patch relaxes it on the pod,
    and reading it back off /object_info is what keeps an unpatched box
    rendering exactly as it did before instead of failing validation on every
    H3 image job. `image_vae` is read off the entry for the same reason from the
    other side: one frame decoded through the VIDEO VAE is a configuration
    nobody has measured, and quietly inventing it would be the third option in a
    choice that only has two good ones.
    """
    if not node_spec or not (h3 or {}).get("image_vae"):
        return H3_IMAGE_FRAMES
    sig = ((node_spec.get("input") or {}).get("required") or {}).get("length")
    opts = sig[1] if isinstance(sig, (list, tuple)) and len(sig) > 1 \
        and isinstance(sig[1], dict) else {}
    lo, step = opts.get("min", H3_IMAGE_FRAMES), opts.get("step", 17)
    return 1 if lo <= 1 and step <= 1 else H3_IMAGE_FRAMES


def h3_snap_dims(width, height):
    """Nearest natively-accepted H3 frame size — but only if it keeps the shape.

    A non-native size is not an error: H3 rescales it internally and the docs
    only warn of "a difference in quality". So snapping is an optimisation, and
    an optimisation must not change what was asked for. Nothing in the native
    list is square, and letting the nearest one win would quietly turn a
    requested 1:1 into a 4:5 portrait — a worse outcome than the quality hit it
    was avoiding. Outside the tolerance we keep the request, rounded to the
    multiple of 32 the latent needs.
    """
    w, h = max(32, int(width)), max(32, int(height))
    portrait = h > w
    # the list is published landscape; either orientation renders
    cands = [(b, a) if portrait else (a, b) for a, b in H3_NATIVE_DIMS]
    target_ar = w / h
    best = min(cands, key=lambda c: (abs((c[0] / c[1]) - target_ar),
                                     abs(c[0] * c[1] - w * h)))
    if abs((best[0] / best[1]) - target_ar) / target_ar <= AR_TOLERANCE:
        return best
    return (round(w / 32) * 32 or 32, round(h / 32) * 32 or 32)


def h3_image_graph(h3, prompt, seed, width, height, *, refs=None, source_image=None,
                   steps=None, negative="", loras=None, node_spec=None, pdd=None):
    """MiniMax H3 as an IMAGE model — the API-format form of "MiniMax H3 Simple
    Image Edit" (Civitai 2833301), run on the ref2va checkpoint.

    The trick is rendering the shortest clip the installed nodes allow and
    keeping one frame of it. Where that is one frame it decodes through the T1
    `image_vae`; where the nodes are stock (`min: 5, step: 17`) it is
    H3_IMAGE_FRAMES = 5 — the 17n+5 grid at n=0, invariant #5 — on the video VAE,
    and frame 0 is sliced out. `h3_image_frames` owns that choice and both halves
    of it. The audio branch is dropped throughout: nothing here has a soundtrack.

    The published workflow drives `MiniMaxH3ImageToVideo` with a single
    `first_frame`, which can only ever edit one picture. `MiniMaxH3ReferenceToVideo`
    takes the same checkpoint we already ship for r2v and conditions on up to
    NINE reference images, so the same idea also does multi-reference image
    composition — more references than any other local image model here (Krea 2
    caps at 4, Klein at 6). `refs` selects that path; `source_image` selects the
    published single-image edit; neither is plain text-to-image.

    `node_spec` is the /object_info entry for `h3_image_node(...)`, and it is
    read for ONE thing: whether this pod's H3 nodes accept `length: 1`
    (h3_image_frames). Deliberately not run through `_fit_node_inputs` — the
    reference slots are dynamic keys (`ref_images.ref_image_N`) that the node
    does not declare, so fitting the shape would drop every reference.

    `pdd` is the official alibaba-pai 8-step distillation, and it is the THIRD
    apply shape here for the same reason it is on the video side: the files
    carry a per-interval HEAD BANK for `final_layer` beside a rank-64 trunk
    LoRA, so an ordinary loader drops half of them silently AND spams ~50
    `ERROR lora … adaln_proj` lines against our pruned int8_convrot weights.
    `MiniMaxH3PDDAccApply` loads the whole thing and EMITS ITS OWN SIGMAS —
    the trained block boundaries — so `BasicScheduler` stops being the
    schedule and the sampler is forced to plain euler. Everything about that
    is `resolve()`'s, one graph over; what is local to a STILL is which file
    is correct, and it follows the CHECKPOINT the way `turbo` already does:
    ref2va when this render conditions on a reference set, fl2va when it
    edits or invents a frame. The two trunks ship identical key sets, so a
    crossed pairing applies cleanly and renders silently wrong — the node
    fingerprints the trunk and errors, which is the only reason that is
    survivable.
    """
    width, height = h3_snap_dims(width, height)
    # H3 ships two checkpoints and they are not interchangeable: ref2va is
    # conditioned on a reference SET, fl2va on an opening frame (or nothing at
    # all, which is its text-to-video path). The builder we pick decides the
    # weights, so a single-image edit cannot silently run on the reference model.
    use_refs = bool(refs) and not source_image
    ckpt = h3.get("ref_checkpoint" if use_refs else "frame_checkpoint") or h3.get("checkpoint")
    # ...and a step distillation is trained against ONE of those checkpoints, so
    # the turbo adapter has to switch with the mode too. lightx2v publishes an
    # fl2v build and a ref2v build at different step counts; putting the fl2v
    # one on ref2va is the same mistake as pairing an adapter with a mode its
    # author never trained it against.
    # Distillations do not stack: PDD rewrites the schedule outright, so a
    # turbo adapter under it is applied to a model that is no longer the one it
    # was distilled from. resolve() refuses the pair outright on the video
    # side; here the row-level `pdd` simply wins and says so.
    if pdd and h3.get("ref_turbo" if use_refs else "frame_turbo"):
        raise ValueError("an H3 image row declares both `pdd` and a turbo "
                         "adapter — distillations don't stack; keep exactly one")
    turbo = {} if pdd else (h3.get("ref_turbo" if use_refs else "frame_turbo") or {})
    steps = int(steps or (pdd or {}).get("steps") or turbo.get("steps")
                or h3.get("steps") or 20)

    # One decision, not two: the T1 decoder is only correct at length 1, and at
    # length 5 it returns grid artifacts (see h3_image_frames).
    frames = h3_image_frames(node_spec, h3)
    vae = h3["image_vae"] if frames == 1 else h3["vae"]
    g = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": ckpt, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": h3["text_encoder"], "type": "minimax",
                         "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": vae}},
        # A distillation rewrites the noise schedule, so its sampler belongs to
        # IT and not to the entry: lightx2v's ref2v v0.1 is published at er_sde
        # while the fl2v 8-step image recipe is sa_solver. One `sampler` field
        # for an entry that switches adapter by mode would have to be wrong for
        # one of them.
        "8": {"class_type": "KSamplerSelect",
              "inputs": {"sampler_name": turbo.get("sampler")
                         or h3.get("sampler") or "res_multistep"}},
        "10": {"class_type": "RandomNoise", "inputs": {"noise_seed": int(seed)}},
    }
    # Turbo first: it is the base the style picks sit on, and a distillation
    # applied after a style adapter is applied to a model that is no longer the
    # one it was distilled from.
    stack = _norm_loras(
        ([{"name": turbo["lora"],
           "strength": turbo.get("strength", h3.get("turbo_strength", 1.0))}]
         if turbo.get("lora") else []) + list(loras or []),
        default_strength=h3.get("lora_strength", 1.0))
    # BOTH the guider and the scheduler read the model, and H3's sigmas come out
    # of BasicScheduler — leaving it on the unpatched model is how a turbo LoRA
    # ends up sampling its distilled step count on the stock schedule.
    model_out = _lora_chain(g, ["1", 0], stack)
    sigmas = None
    if pdd:
        # ref2va when a reference SET is conditioning this render, fl2va when
        # it is an edit or a text-to-image — the same test that already chose
        # the checkpoint above, so the pairing cannot disagree with it.
        pdd_file = pdd.get("ref2va" if use_refs else "fl2va") or pdd.get("file")
        if not pdd_file:
            raise ValueError(
                f"no PDD file declared for the "
                f"{'ref2va' if use_refs else 'fl2va'} checkpoint this render "
                f"runs on")
        g["16"] = {"class_type": "MiniMaxH3PDDAccApply",
                   "inputs": {"model": model_out, "pdd_file": pdd_file,
                              # the node's combo takes the count as a STRING
                              "nfe": str(pdd.get("nfe", "8")),
                              "lora_strength": float(pdd.get("lora_strength", 1.0)),
                              "head_strength": float(pdd.get("head_strength", 1.0)),
                              # refuse off-grid evaluation rather than degrade
                              # quietly, exactly as resolve() does
                              "on_off_grid": "error"}}
        model_out, sigmas = ["16", 0], ["16", 1]
        # Each step consumes one mean block velocity; a multi-stage sampler
        # evaluates the trunk between trained boundaries and the node fails
        # closed. BasicScheduler is still BUILT (it reads the patched model and
        # costs nothing) and simply stops being what the sampler reads.
        g["8"]["inputs"]["sampler_name"] = "euler"
    g["9"] = {"class_type": "BasicScheduler",
              "inputs": {"model": model_out,
                         "scheduler": turbo.get("scheduler")
                         or h3.get("scheduler") or "simple",
                         "steps": steps, "denoise": 1.0}}
    if not use_refs:
        g["6"] = {"class_type": "MiniMaxH3ImageToVideo",
                  "inputs": {"clip": ["2", 0], "vae": ["3", 0], "prompt": prompt,
                             "width": width, "height": height,
                             "length": frames}}
        # No first_frame at all is H3's text-to-video path — i.e. plain t2i here.
        if source_image:
            g["5"] = {"class_type": "LoadImage", "inputs": {"image": source_image}}
            g["6"]["inputs"]["first_frame"] = ["5", 0]
    else:
        ins = {"clip": ["2", 0], "vae": ["3", 0], "prompt": prompt,
               "width": width, "height": height, "length": frames,
               "ref_image_size": "match"}
        # ref2va wants its audio VAE wired even when nothing has audio.
        if h3.get("audio_vae"):
            g["4"] = {"class_type": "VAELoader", "inputs": {"vae_name": h3["audio_vae"]}}
            ins["audio_vae"] = ["4", 0]
        for i, name in enumerate((refs or [])[:9]):
            node = str(20 + i)
            g[node] = {"class_type": "LoadImage", "inputs": {"image": name}}
            ins[f"ref_images.ref_image_{i}"] = [node, 0]
        g["6"] = {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": ins}

    g["7"] = {"class_type": "BasicGuider",
              "inputs": {"model": model_out, "conditioning": ["6", 0]}}
    g["11"] = {"class_type": "SamplerCustomAdvanced",
               "inputs": {"noise": ["10", 0], "guider": ["7", 0], "sampler": ["8", 0],
                          "sigmas": sigmas or ["9", 0], "latent_image": ["6", 1]}}
    g["12"] = {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}}
    # Keep the first frame and throw the rest away — that is the image. A no-op
    # on the single-frame path, and left in on purpose: it is what guarantees
    # exactly one image reaches SaveImage whatever `frames` came out as.
    g["13"] = {"class_type": "ImageFromBatch",
               "inputs": {"image": ["12", 0], "batch_index": 0, "length": 1}}
    g["14"] = {"class_type": "SaveImage",
               "inputs": {"images": ["13", 0], "filename_prefix": "neon/h3img"}}
    _ = negative        # H3 conditions inside the latent builder; no negative branch
    return g


# ---------------------------------------------------------- H3 SHEETS ------
# A reference sheet as ONE ref2va take, on CORE NODES ONLY.
#
# The premise is the ORBIT SHEETS block below and it is not repeated here; what
# differs is the two things that make this the one to reach for:
#
#   * it conditions on a reference SET (up to nine pictures) instead of one
#     opening frame, so a bible entry's face plate, body sheet and outfit
#     variant all reach the take that is supposed to reconcile them;
#   * every node in it ships with ComfyUI. The orbit path needs
#     lumos675/ComfyUI-OrbitSheets present AND importable for its prompt
#     builders, its frame picker and its contact sheet; this needs nothing, and
#     `worker/h3_sheet.py` writes the prompt in deterministic Python where the
#     format is pinned by tests rather than by a third party's release.
#
# THE FRAMES ARE CHOSEN BY INDEX, NOT BY A JUDGE. `h3_sheet.plan_*` states
# which frame each view comes from, and it states it from the same arithmetic
# that wrote the cut stamps into the prompt — so the extractor samples the
# middle of a shot rather than the boundary H3 blurs through. Content
# clustering was the alternative and it is worse here for a reason that only
# shows up on a turnaround: two adjacent angles of one frozen subject are
# NEARLY IDENTICAL, which is exactly when a clusterer merges them and returns
# five views where six were asked for.


def _autogrow_key(spec, group, i, default_prefix=""):
    """The API key for the i-th slot of an autogrow input.

    NAMESPACED, and the prefix is the NODE'S — `ref_images.ref_image_0` on the
    H3 reference node (prefix `ref_image_`) but `images.image0` on
    BatchImagesNode (prefix `image`). Both are read off the same
    `template.prefix` field, so guessing one from the other is what produces a
    key ComfyUI silently DROPS rather than rejects: a sheet that renders one
    reference, or a save node that writes one view.
    """
    for sect in ("required", "optional"):
        v = (((spec or {}).get("input") or {}).get(sect) or {}).get(group)
        if isinstance(v, (list, tuple)) and len(v) > 1 and isinstance(v[1], dict):
            pre = ((v[1].get("template") or {}).get("prefix"))
            if pre:
                return f"{group}.{pre}{i}"
    return f"{group}.{default_prefix}{i}"


def _sheet_columns(n, want):
    """A column count that DIVIDES the view count, at or below `want`.

    A ragged last row is not a cosmetic problem: `ImageStitch` stacks with
    `match_image_size`, so a one-cell row under a four-cell row is SCALED UP to
    the full width — one view rendered four times the size of its neighbours,
    with its aspect ratio intact and its scale nonsense. Every plan here
    already divides evenly; this is what keeps a hand-passed `shots=5` from
    producing a sheet nobody would notice was wrong until they measured it.
    Falling back to a single row is undistorted and honest.
    """
    n, want = int(n), max(1, int(want))
    for c in range(min(want, n), 1, -1):
        if n % c == 0:
            return c
    return n


def _stitch_sheet(g, view_ids, columns, base=200):
    """Rows of `columns` joined right, then stacked down. Core `ImageStitch`.

    Returns the node id of the finished sheet. `match_image_size` is on
    because a cell whose aspect differs by a pixel makes the row it is in a
    different height from every other row.
    """
    columns = _sheet_columns(len(view_ids), columns)

    def _pair(nid, a, b, direction):
        g[nid] = {"class_type": "ImageStitch",
                  "inputs": {"image1": a, "image2": b, "direction": direction,
                             "match_image_size": True, "spacing_width": 6,
                             "spacing_color": "black"}}
        return [nid, 0]

    nid = base
    rows = []
    for r in range(0, len(view_ids), columns):
        chunk = view_ids[r:r + columns]
        acc = chunk[0]
        for nxt in chunk[1:]:
            acc = _pair(str(nid), acc, nxt, "right")
            nid += 1
        rows.append(acc)
    sheet = rows[0]
    for nxt in rows[1:]:
        sheet = _pair(str(nid), sheet, nxt, "down")
        nid += 1
    return sheet


def h3_sheet_graph(h3, prompt, seed, *, refs, frames, length, width, height,
                   steps=None, columns=2, prefix="qamba/sheet", loras=None,
                   node_spec=None, batch_spec=None, sigma_shift=None,
                   pdd=None):
    """One ref2va take -> one image per entry in `frames`, plus a contact sheet.

    `frames` is the plan's absolute frame indices, in view order. `refs` are
    staged filenames, at most nine — the node's own ceiling, and more than any
    other local image model here takes.

    Node "301" saves the individual views (one file per frame, through
    `BatchImagesNode` so a single save node writes them all) and "302" the
    sheet.
    """
    if not refs:
        raise ValueError("an H3 sheet is a reference take — it needs at least "
                         "one staged picture")
    if not frames:
        raise ValueError("an H3 sheet needs at least one view frame")
    if pdd and sigma_shift:
        # PDD emits the trained block boundaries as its own SIGMAS; shifting
        # the model's schedule under it moves every evaluation off that grid,
        # which the apply node is configured to refuse outright rather than
        # render quietly wrong. Same rule as `pdd` + `turbo_lora` in resolve().
        raise ValueError("PDD supplies its own trained sigmas — a sigma shift "
                         "on top of it is off-grid; keep exactly one")
    ckpt = h3.get("ref_checkpoint") or h3.get("checkpoint")
    if not ckpt:
        raise ValueError("no ref2va checkpoint declared — a sheet conditions "
                         "on a reference set")
    turbo = {} if pdd else (h3.get("ref_turbo") or {})
    steps = int(steps or (pdd or {}).get("steps") or turbo.get("steps")
                or h3.get("steps") or 25)
    g = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": ckpt, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": h3["text_encoder"], "type": "minimax",
                         "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": h3["vae"]}},
        # REQUIRED on this node even with nothing audible in the take — it is
        # in `required`, not `optional`, so omitting it is a validation failure
        # rather than a silent drop.
        "4": {"class_type": "VAELoader",
              "inputs": {"vae_name": h3["audio_vae"]}},
        # Both published workflows ship euler + linear_quadratic at 25 steps,
        # and that pairing is the recipe rather than a default: this is a
        # multi-shot take whose whole product is a handful of SETTLED frames,
        # where the templates' res_multistep/simple is tuned for motion.
        "8": {"class_type": "KSamplerSelect",
              "inputs": {"sampler_name": turbo.get("sampler")
                         or h3.get("sheet_sampler") or "euler"}},
        "10": {"class_type": "RandomNoise", "inputs": {"noise_seed": int(seed)}},
    }
    stack = _norm_loras(
        ([{"name": turbo["lora"],
           "strength": turbo.get("strength", h3.get("turbo_strength", 1.0))}]
         if turbo.get("lora") else []) + list(loras or []),
        default_strength=h3.get("lora_strength", 1.0))
    model_out = _lora_chain(g, ["1", 0], stack)
    if sigma_shift:
        g["15"] = {"class_type": "MiniMaxH3SigmaShift",
                   "inputs": {"model": model_out,
                              "shift_video": float(sigma_shift[0]),
                              "shift_audio": float(sigma_shift[1])}}
        model_out = ["15", 0]
    sigmas = None
    if pdd:
        # The file follows the CHECKPOINT, and this graph always loads the
        # ref2va trunk (a sheet conditions on a reference set — see the guard
        # above), so ref2va is the only correct build here. Read straight off
        # the model_map `pdd` block, which is what every caller actually has:
        # this used to index a pre-resolved `pdd["file"]`, a shape that exists
        # nowhere in model_map, so EVERY sheet job died on `KeyError: 'file'`
        # the moment one was queued through the worker. The unit tests passed
        # because their fixture invented that key.
        #
        # The two trunks ship identical key sets, so a crossed pairing applies
        # cleanly and renders silently wrong; the node fingerprints the trunk
        # and errors. Same lookup and same fallback as `h3_image_graph`.
        pdd_file = pdd.get("ref2va") or pdd.get("file")
        if not pdd_file:
            raise ValueError(
                "no PDD file declared for the ref2va checkpoint this sheet "
                "runs on (model_map `pdd.ref2va`)")
        g["16"] = {"class_type": "MiniMaxH3PDDAccApply",
                   "inputs": {"model": model_out,
                              "pdd_file": pdd_file,
                              "nfe": str(pdd.get("nfe", "8")),
                              "lora_strength": float(pdd.get("lora_strength", 1.0)),
                              "head_strength": float(pdd.get("head_strength", 1.0)),
                              "on_off_grid": "error"}}
        model_out, sigmas = ["16", 0], ["16", 1]
        # Each PDD step consumes one mean block velocity, so a multi-stage
        # sampler evaluates the trunk between trained boundaries and the node
        # fails closed. resolve() forces the same thing on the video side.
        g["8"]["inputs"]["sampler_name"] = "euler"
    g["9"] = {"class_type": "BasicScheduler",
              "inputs": {"model": model_out,
                         "scheduler": turbo.get("scheduler")
                         or h3.get("sheet_scheduler") or "linear_quadratic",
                         "steps": steps, "denoise": 1.0}}
    ins = {"clip": ["2", 0], "vae": ["3", 0], "audio_vae": ["4", 0],
           "prompt": prompt, "width": int(width), "height": int(height),
           "length": int(length), "ref_image_size": "match"}
    for i, name in enumerate(list(refs)[:9]):
        nid = str(20 + i)
        g[nid] = {"class_type": "LoadImage", "inputs": {"image": name}}
        ins[_autogrow_key(node_spec, "ref_images", i, "ref_image_")] = [nid, 0]
    g["6"] = {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": ins}
    g["7"] = {"class_type": "BasicGuider",
              "inputs": {"model": model_out, "conditioning": ["6", 0]}}
    g["11"] = {"class_type": "SamplerCustomAdvanced",
               "inputs": {"noise": ["10", 0], "guider": ["7", 0],
                          "sampler": ["8", 0],
                          "sigmas": sigmas or ["9", 0],
                          "latent_image": ["6", 1]}}
    g["12"] = {"class_type": "VAEDecode",
               "inputs": {"samples": ["11", 0], "vae": ["3", 0]}}

    picks = []
    for i, f in enumerate(frames):
        nid = str(100 + i)
        g[nid] = {"class_type": "ImageFromBatch",
                  "inputs": {"image": ["12", 0],
                             # clamped here as well as in the plan: a frame
                             # past the end returns the LAST frame rather than
                             # raising, so an off-by-one silently duplicates a
                             # view instead of failing
                             "batch_index": max(0, min(int(f), int(length) - 1)),
                             "length": 1}}
        picks.append([nid, 0])

    batch = {}
    for i, p in enumerate(picks):
        batch[_autogrow_key(batch_spec, "images", i, "image")] = p
    g["300"] = {"class_type": "BatchImagesNode", "inputs": batch}
    g["301"] = {"class_type": "SaveImage",
                "inputs": {"images": ["300", 0],
                           "filename_prefix": f"{prefix}/view"}}
    g["302"] = {"class_type": "SaveImage",
                "inputs": {"images": _stitch_sheet(g, picks, max(1, int(columns))),
                           "filename_prefix": f"{prefix}/sheet"}}
    return g


# --------------------------------------------------------- ORBIT SHEETS ----
# A reference sheet rendered as ONE H3 take instead of angle-by-angle.
#
# The problem it fixes is measured and written down twice already: a location's
# four plates drawn as four independent renders come back as four crops of one
# frontal view when they are drawn on H3 (which is why `sheet_job` forces
# derived plates onto krea2), and a character's turnaround drawn as a grid is
# a composition the image models routinely refuse. One H3 take cannot drift
# between its own views the way four renders can, because every view is the
# same shot — and H3 hard-CUTS between locked-off angles rather than orbiting,
# which is what stopped the rolling horizons the continuous move produced.
#
# lumos675/ComfyUI-OrbitSheets (MIT) owns the prompt builders and the frame
# picker; this builds its graph against OUR file names. Four things the pack's
# own example graphs get wrong for us and this deliberately does not:
#   * their paths are subdir'd (`MinimaxH3/…`) and ours are flat;
#   * they load a `minimax_h3_ref_lora_rank_256_bf16` that is in no model_map
#     here and in the pack's own README requirements table either — dropped;
#   * both seeds ship as 0, which is the seed-0 trap `handle_image_gen`
#     already documents: every re-roll returns the identical sheet;
#   * they never save the SELECTED FRAMES, only the contact sheet — and the
#     individual plates are the whole point for a bible slot.
ORBIT_W, ORBIT_H = 1216, 672      # H3-native, and what the pack's graphs use
ORBIT_FRAMES = 124                # 17*7+5 — five ~1s shots, invariant #5


def orbit_sheet_graph(h3, prompt, seed, *, anchor, shots, count=None,
                      width=ORBIT_W, height=ORBIT_H, length=ORBIT_FRAMES,
                      steps=None, want_audio=False, columns=2,
                      prefix="qamba/orbit", node_spec=None):
    """One H3 i2v take of a subject from several angles -> per-view plates.

    `anchor` is the staged opening frame (a character's own full-body sheet, a
    location's master plate); `prompt` is an OrbitSheets-built cut list.
    `shots` is how many distinct views that prompt asks for, and it is the
    load-bearing number: `count == shots` makes the picker take exactly one
    sharp frame per view by content clustering and SKIP the vision judge
    entirely. That matters here beyond speed — the judge's `free_vram_first`
    calls `unload_all_models()` mid-graph, which on this pod would evict a
    resident H3 in the middle of the gpu lane's own job.

    Returns the graph. Node "60" outputs the selected frames (SaveImage "62",
    one file per frame) and "61" the contact sheet (SaveImage "63").
    """
    turbo = h3.get("frame_turbo") or {}
    steps = int(steps or turbo.get("steps") or h3.get("steps") or 20)
    n = int(count or shots)
    g = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": h3.get("frame_checkpoint") or h3["checkpoint"],
                         "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": h3["text_encoder"], "type": "minimax",
                         "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": h3["vae"]}},
        "5": {"class_type": "LoadImage", "inputs": {"image": anchor}},
        "8": {"class_type": "KSamplerSelect",
              "inputs": {"sampler_name": turbo.get("sampler")
                         or h3.get("sampler") or "res_multistep"}},
        "10": {"class_type": "RandomNoise", "inputs": {"noise_seed": int(seed)}},
    }
    stack = _norm_loras(
        [{"name": turbo["lora"],
          "strength": turbo.get("strength", h3.get("turbo_strength", 1.0))}]
        if turbo.get("lora") else [],
        default_strength=h3.get("lora_strength", 1.0))
    model_out = _lora_chain(g, ["1", 0], stack)
    g["9"] = {"class_type": "BasicScheduler",
              "inputs": {"model": model_out,
                         "scheduler": turbo.get("scheduler")
                         or h3.get("scheduler") or "simple",
                         "steps": steps, "denoise": 1.0}}
    ins = {"clip": ["2", 0], "vae": ["3", 0], "prompt": prompt,
           "width": int(width), "height": int(height), "length": int(length),
           "first_frame": ["5", 0]}
    g["6"] = {"class_type": "MiniMaxH3ImageToVideo",
              "inputs": _fit_node_inputs(ins, node_spec)}
    g["7"] = {"class_type": "BasicGuider",
              "inputs": {"model": model_out, "conditioning": ["6", 0]}}
    g["11"] = {"class_type": "SamplerCustomAdvanced",
               "inputs": {"noise": ["10", 0], "guider": ["7", 0],
                          "sampler": ["8", 0], "sigmas": ["9", 0],
                          "latent_image": ["6", 1]}}
    g["12"] = {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}}
    g["60"] = {"class_type": "OrbitSheetsFrameSelect",
               "inputs": {
                   "images": ["12", 0], "count": n, "mode": "vision_llm",
                   "candidates": 32,
                   # frame 0 IS the anchor view, so keeping it spends a slot on
                   # a duplicate and pushes the last cluster off the end
                   "keep_first_frame": False,
                   "sharpness_weight": 0.35,
                   # never mid-graph on the gpu lane — see the docstring
                   "free_vram_first": False,
                   "sharpness_gate": True, "shots": int(shots), "boards": 1,
                   "shot_split": "views (by content)"}}
    g["61"] = {"class_type": "OrbitSheetsContactSheet",
               "inputs": {"images": ["60", 0], "columns": int(columns),
                          "cell_width": 512, "padding": 8,
                          # burnt-in text follows the frame into every render
                          # that later stages it as a reference
                          "label_frames": False, "label_prefix": ""}}
    g["62"] = {"class_type": "SaveImage",
               "inputs": {"images": ["60", 0], "filename_prefix": f"{prefix}/view"}}
    g["63"] = {"class_type": "SaveImage",
               "inputs": {"images": ["61", 0], "filename_prefix": f"{prefix}/sheet"}}
    # The voice sample. H3 carries audio in the SAME latent as the picture
    # whether or not anything asked for it, so a character turnaround that
    # speaks costs no extra sampling — only a second decode. Note the audio
    # VAE is NOT an input to the i2v builder the way it is on the ref2va one:
    # `MiniMaxH3ImageToVideo` declares clip/vae/prompt/width/height/length/
    # first_frame/last_frame and nothing else (checked against the pod's live
    # /object_info — passing it there is silently dropped by _fit_node_inputs
    # and would look like the audio branch simply not working).
    if want_audio and h3.get("audio_vae"):
        g["4"] = {"class_type": "VAELoader",
                  "inputs": {"vae_name": h3["audio_vae"]}}
        g["52"] = {"class_type": "VAEDecodeAudio",
                   "inputs": {"samples": ["11", 0], "vae": ["4", 0]}}
        g["53"] = {"class_type": "SaveAudio",
                   "inputs": {"audio": ["52", 0],
                              "filename_prefix": f"{prefix}/voice"}}
    return g


# The pack's own prompt builders write H3's multi-shot cut format — the
# `[Shot N] At MM:SS.mmm, the shot cuts to…` grammar, the I2VA first-frame
# alignment line, the locked-off-camera phrasing that beat every continuous
# move they tried, and the rotation clamp. They run IN THE GRAPH rather than
# being reimplemented here for the reason `prompt_guides.js` stopped
# paraphrasing the vendor docs: a distillation drifts from the thing it
# distils, and this one is tested upstream against its own H3 conformance
# suite. Invariant #6 is intact either way — a sheet's prompt is written by
# deterministic code, not by an LLM.
ORBIT_CHAR_SHOTS = 6              # body, face, left, right, back, scared
ORBIT_LOC_SHOTS = 4               # front, right, rear, left (+2 with the extras)


def orbit_character_graph(h3, description, seed, *, anchor, style,
                          spoken_line="", voice_description="", language="English",
                          framing="full body, generous margin", scared_shot=True,
                          shot_seconds=0.75, backdrop=None, **kw):
    """A character turnaround sheet, and its voice sample.

    `spoken_line` is what makes the same sampling pass also produce a
    voice-timbre reference: H3 decodes picture and sound from ONE latent, so
    the line costs nothing beyond the words. Leave it empty for a silent turn.
    """
    shots = ORBIT_CHAR_SHOTS if scared_shot else ORBIT_CHAR_SHOTS - 1
    ins = {"character_description": description,
           # REQUIRED on the node, and the pack's own example graph omits it —
           # a missing required widget is a 400 at validation, not a default.
           "visual_style": style or "Cinematic, live-action",
           "framing": framing, "scared_shot": bool(scared_shot),
           "shot_seconds": float(shot_seconds), "language": language,
           "silent_during_closeup": True}
    if backdrop:
        ins["backdrop"] = backdrop
    if spoken_line:
        ins["spoken_line"] = spoken_line
    if voice_description:
        ins["voice_description"] = voice_description
    g = orbit_sheet_graph(h3, ["30", 0], seed, anchor=anchor, shots=shots,
                          want_audio=bool(spoken_line), columns=3, **kw)
    g["30"] = {"class_type": "OrbitSheetsCharacterPrompt", "inputs": ins}
    return g


def orbit_location_graph(h3, description, seed, *, anchor, style,
                         space="interior", wide=True, detail=True,
                         shot_seconds=1.0, time_of_day="", ambient_sound="", **kw):
    """A location sheet: four orthogonal locked-off views, plus an optional
    wide establisher and a detail — which is exactly the master / alt_angle /
    atmosphere / detail plate set, shot as one take so the four agree."""
    shots = ORBIT_LOC_SHOTS + int(bool(wide)) + int(bool(detail))
    ins = {"location_description": description,
           "visual_style": style or "Cinematic, live-action",
           "space": space, "coverage": "cut views",
           "rotation": "auto (as far as the take allows)",
           "wide_establishing_shot": bool(wide), "detail_shot": bool(detail),
           "shot_seconds": float(shot_seconds),
           "time_of_day": time_of_day, "ambient_sound": ambient_sound}
    g = orbit_sheet_graph(h3, ["30", 0], seed, anchor=anchor, shots=shots,
                          want_audio=False, columns=3, **kw)
    g["30"] = {"class_type": "OrbitSheetsLocationPrompt", "inputs": ins}
    return g


# HiDream-O1 is trained at these sizes and drifts off them; the panel path asks
# for 1280x704, which is nowhere near. Snap to the nearest trained shape with a
# matching aspect and downscale after, rather than rendering out of distribution.
HIDREAM_O1_DIMS = [
    (2048, 2048), (2304, 1728), (2304, 1792), (2496, 1664), (2560, 1440),
    (3104, 1312), (1728, 2304), (1792, 2304), (1664, 2496), (1440, 2560),
    (1312, 3104),
]


def hidream_o1_dims(width, height):
    """Nearest trained resolution by aspect ratio. Pure."""
    want = float(width) / float(height or 1)
    return min(HIDREAM_O1_DIMS, key=lambda d: abs(d[0] / d[1] - want))


def hidream_o1_graph(hm, prompt, seed, width, height, refs=None, *, negative="",
                     steps=None, cfg=None, node_spec=None, snap=True):
    """HiDream-O1-Image — the instruction-follower, for storyboard panels.

    Why it exists: Krea 2 renders a medium two-shot for every panel whatever
    [FRAMING] asks, so wide/establishing shots came back with the location
    missing (measured across AFTERLIGHT E3, then confirmed by handing the
    IDENTICAL prompt and reference sheets to a stronger model, which produced
    the planned wide). O1 is the local answer to that: MIT licence, NATIVE
    ComfyUI nodes — no custom pack that can silently go missing the way
    Krea2EditRebalance can — and it takes ten references against Krea 2's four.

    Shape follows ComfyUI's own `image_hidream_o1` template rather than
    anything invented here:
      * ONE checkpoint carries model + text encoder + image tower
        (`CheckpointLoaderSimple`), so there is no separate CLIPLoader or
        VAELoader to point at — the Pixel-level Unified Transformer has no
        external VAE.
      * References attach to BOTH conditionings through
        `HiDreamO1ReferenceImages`, whose autogrow inputs are flat keys
        `image_1`..`image_10` (comfy_extras/nodes_hidream_o1.py reads exactly
        those names). One image reads as an edit instruction, two or more as
        subject-driven personalization — which is the panel case.
      * `SamplerCustom` at cfg 5 over `BasicScheduler` sigmas, NOT KSampler,
        and `ModelNoiseScale` sits ahead of the scheduler.
    """
    if snap:
        width, height = hidream_o1_dims(width, height)
    steps = int(steps or hm.get("steps", 40))
    cfg = float(cfg if cfg is not None else hm.get("cfg", 5.0))
    g = {
        "1": {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": hm["checkpoint"]}},
        "2": {"class_type": "ModelNoiseScale",
              "inputs": {"model": ["1", 0],
                         "noise_scale": float(hm.get("noise_scale", 8.0))}},
        "4": {"class_type": "CLIPTextEncode",
              "inputs": {"clip": ["1", 1], "text": prompt}},
        "5": {"class_type": "CLIPTextEncode",
              "inputs": {"clip": ["1", 1], "text": negative or ""}},
        "7": {"class_type": "EmptyHiDreamO1LatentImage",
              "inputs": {"width": int(width), "height": int(height), "batch_size": 1}},
        "8": {"class_type": "KSamplerSelect",
              "inputs": {"sampler_name": hm.get("sampler", "dpmpp_2m_sde_gpu")}},
        "9": {"class_type": "BasicScheduler",
              "inputs": {"model": ["2", 0], "scheduler": hm.get("scheduler", "normal"),
                         "steps": steps, "denoise": 1.0}},
    }
    # Seam smoothing is a late-schedule model patch the template applies by
    # default; keep it optional so a map entry can drop it without a code edit.
    model_src = ["2", 0]
    if hm.get("seam_smoothing", True):
        g["3"] = {"class_type": "HiDreamO1PatchSeamSmoothing",
                  "inputs": _fit_node_inputs(
                      {"model": ["2", 0], "start_percent": 0.8, "end_percent": 1.0,
                       "pattern": "single_shift", "passes": "2", "blend": "average",
                       "strength": 1.0}, node_spec)}
        model_src = ["3", 0]

    ref_in = {"positive": ["4", 0], "negative": ["5", 0]}
    for i, name in enumerate((refs or [])[:10], start=1):
        g[str(20 + i)] = {"class_type": "LoadImage", "inputs": {"image": name}}
        # NAMESPACED: the API key is `images.image_N`, even though the node's
        # execute() reads the bare `image_N`. ComfyUI only tells you via
        # extra_info.input_name on the validation error — a bare `image_1` is
        # rejected as "Required input is missing: image_1", which reads like
        # the key is absent rather than misspelt.
        ref_in[f"images.image_{i}"] = [str(20 + i), 0]
    pos, neg = ["4", 0], ["5", 0]
    if len(ref_in) > 2:
        g["6"] = {"class_type": "HiDreamO1ReferenceImages", "inputs": ref_in}
        pos, neg = ["6", 0], ["6", 1]

    g["10"] = {"class_type": "SamplerCustom",
               "inputs": {"model": model_src, "add_noise": True,
                          "noise_seed": int(seed), "cfg": cfg,
                          "positive": pos, "negative": neg,
                          "sampler": ["8", 0], "sigmas": ["9", 0],
                          "latent_image": ["7", 0]}}
    g["11"] = {"class_type": "VAEDecode",
               "inputs": {"samples": ["10", 0], "vae": ["1", 2]}}
    g["12"] = {"class_type": "SaveImage",
               "inputs": {"images": ["11", 0], "filename_prefix": "neon/hidreamo1"}}
    return g


# The exact strings `SenseNovaU1LocalTextToImage.resolution` offers, read off
# the installed node rather than transcribed: the label after the pipe is the
# vendor's ROUNDED name for the shape and is NOT derivable from the numbers.
# 2720x1536 is 85:48 and is labelled 16:9; 2368x1760 is 74:55 and is labelled
# 4:3. Four of the eleven are approximations like that, so a resolution built
# by reducing the fraction is rejected at submit as not-in-list — a dead job,
# not a degraded picture.
SENSENOVA_T2I_OPTIONS = [
    "2048x2048|1:1", "2720x1536|16:9", "1536x2720|9:16", "2496x1664|3:2",
    "1664x2496|2:3", "2368x1760|4:3", "1760x2368|3:4", "1440x2880|1:2",
    "2880x1440|2:1", "1152x3456|1:3", "3456x1152|3:1",
]
SENSENOVA_T2I_DIMS = [
    tuple(int(v) for v in o.split("|", 1)[0].split("x"))
    for o in SENSENOVA_T2I_OPTIONS
]
# Every option is ~4MP: this model generates natively at 4K-class sizes and has
# no small mode, so a 1280x704 panel ask becomes 2720x1536 and is downscaled by
# whoever consumes it.


def sensenova_dims(width, height):
    """Nearest offered T2I resolution by aspect ratio. Pure."""
    want = float(width) / float(height or 1)
    return min(SENSENOVA_T2I_DIMS, key=lambda d: abs(d[0] / d[1] - want))


def _sensenova_resolution(width, height):
    """The COMBO string the node expects, e.g. `2720x1536|16:9`."""
    w, h = sensenova_dims(width, height)
    return SENSENOVA_T2I_OPTIONS[SENSENOVA_T2I_DIMS.index((w, h))]


def _sensenova_loader(sn, nid="1"):
    """The LOCAL loader, pointed at an explicit path on /data.

    Deliberately `SenseNovaU1LocalLoader` and not the newer
    `SenseNovaU1ModelLoader`: that one's `model_weights` is a COMBO of
    HuggingFace ids, so it would fetch its own 35GB copy into the HF cache at
    render time and ignore the one the engine window's model list sensenova already put on
    /data. This loader takes a free-form `model_path`, which is the only input
    on either node that can name a local directory. Its display name says
    "(Legacy)" — it is still registered and still the documented local path,
    but if a future release drops it the replacement must gain a path input
    before this can move.
    """
    return {nid: {"class_type": "SenseNovaU1LocalLoader", "inputs": {
        "model_path": sn["model_path"],
        "sensenova_u1_src": "",
        "device": sn.get("device", "cuda"),
        "dtype": sn.get("dtype", "bfloat16"),
        # `flash` when flash-attn is installed (it is, 2.8.3.post1); `auto`
        # resolves it and falls back to sdpa rather than failing.
        "attn_backend": sn.get("attn_backend", "auto"),
        # device_map shards across GPUs and is mutually exclusive with
        # vram_mode. One 96GB card, 35GB of weights: neither is needed, and
        # `full` (no offload) is what makes a warm render 30s rather than
        # minutes of per-layer swapping.
        "device_map": "none", "max_memory": "",
        "vram_mode": sn.get("vram_mode", "full"),
        "gguf_checkpoint": ""}}}


def sensenova_graph(sn, prompt, seed, width, height, refs=None, *,
                    steps=None, cfg=None, img_cfg=None, cfg_norm=None,
                    timestep_shift=None, think_mode=False):
    """SenseNova-U1.5-8B-MoT — a unified multimodal model, as an image model.

    Why it is shaped unlike every other builder here: this model does NOT plug
    into ComfyUI's latent/KSampler interface at all. The pack's own README says
    so in as many words — `t2i_generate` / `it2i_generate` run their own
    sampling loop inside the node — so there is no CLIPLoader, no VAE, no
    sigmas and nothing for `resolve.py` to parameterise by `class_type`. The
    whole graph is three nodes: load, generate, save. It follows that none of
    the studio's sampler-shaped knobs (sampler, scheduler, denoise, LoRA
    splicing) exist on this family; `steps` and the two CFG scales are the
    controls it really has.

    TWO PATHS, chosen by whether references are staged, exactly as krea2 splits
    `krea2_graph` from `krea2_ref_graph`:

      * no refs -> `SenseNovaU1LocalTextToImage`, whose size is a COMBO (see
        `_sensenova_resolution`).
      * refs    -> `SenseNovaU1LocalImageEdit`, which is BOTH the edit path and
        the multi-reference compose path — `image` is the primary and
        `image2`..`image10` ride an autogrow input, so this family carries TEN
        references against Krea 2's four and Qwen's three.

    The autogrow key is NAMESPACED — `reference_images.image2`, not a bare
    `image2` — the same trap `hidream_o1_graph` documents for
    `images.image_N`. A bare key is silently dropped rather than rejected, so
    it is verified rather than assumed: the node's own `metadata_json` reports
    `input_image_count`, which read 2 for a two-image graph built this way.
    """
    refs = list(refs or [])
    steps = int(steps or sn.get("steps", 50))
    cfg = float(cfg if cfg is not None else sn.get("cfg", 4.0))
    shift = float(timestep_shift if timestep_shift is not None
                  else sn.get("timestep_shift", 3.0))
    norm = cfg_norm or sn.get("cfg_norm", "none")
    g = _sensenova_loader(sn)

    if not refs:
        g["2"] = {"class_type": "SenseNovaU1LocalTextToImage", "inputs": {
            "u1_model": ["1", 0], "prompt": prompt,
            "resolution": _sensenova_resolution(width, height),
            "cfg_scale": cfg, "cfg_norm": norm, "timestep_shift": shift,
            "cfg_interval_start": 0.0, "cfg_interval_end": 1.0,
            "num_steps": steps, "batch_size": 1, "seed": int(seed),
            "think_mode": bool(think_mode)}}
    else:
        cap = int(sn.get("max_refs", 10))
        for i, name in enumerate(refs[:cap]):
            g[str(10 + i)] = {"class_type": "LoadImage", "inputs": {"image": name}}
        # An explicit output size, rather than the node's own "Auto - 4MP"
        # default: a storyboard panel and a character sheet are different
        # shapes, and auto takes its aspect from the FIRST input — which on a
        # panel is whichever reference happened to sort first.
        g["5"] = {"class_type": "SenseNovaU1EditOutputSize", "inputs": {
            "preset": "Custom", "width": int(width), "height": int(height)}}
        ins = {"u1_model": ["1", 0], "image": ["10", 0], "prompt": prompt,
               "output_size": ["5", 0],
               "cfg_scale": cfg,
               # How hard the OUTPUT is pulled toward the input images. 1.0 is
               # the vendor default and means "no image-side guidance"; raising
               # it holds the references harder at the cost of the instruction.
               "img_cfg_scale": float(img_cfg if img_cfg is not None
                                      else sn.get("img_cfg", 1.0)),
               # `cfg_zero_star` exists on the T2I node only — the edit node's
               # own combo omits it and its pipeline RAISES on it. Coerce
               # rather than pass through, or a model-level default set for
               # t2i kills every reference render on the family.
               "cfg_norm": norm if norm != "cfg_zero_star" else "none",
               "timestep_shift": shift,
               "cfg_interval_start": 0.0, "cfg_interval_end": 1.0,
               "num_steps": steps, "batch_size": 1, "seed": int(seed),
               "think_mode": bool(think_mode)}
        for i in range(1, len(refs[:cap])):
            ins[f"reference_images.image{i + 1}"] = [str(10 + i), 0]
        g["2"] = {"class_type": "SenseNovaU1LocalImageEdit", "inputs": ins}

    g["3"] = {"class_type": "SaveImage",
              "inputs": {"images": ["2", 0], "filename_prefix": "neon/sensenova"}}
    return g


def qwen_edit_graph(qe, prompt, seed, width, height, refs=None, *, negative="",
                    steps=None, cfg=None, loras=None, node_spec=None,
                    negative_refs=None):
    """Qwen-Image-Edit 2509 — the reference-driven image model, and the default
    fallback for any job that carries references.

    `TextEncodeQwenImageEditPlus` is a CORE ComfyUI node (comfy_extras.nodes_qwen),
    not a custom one, so unlike the Krea 2 path this cannot silently fall back
    for want of an install. It takes **three** images — image1..image3 — and is
    handed the VAE so it encodes them into the conditioning itself; that is the
    2509 contract and why the base Qwen-Image-Edit node (one image) is not what
    a multi-reference path wants.

    Both the positive and the negative encode see the same references; only the
    prompt differs. The latent starts empty at the requested size: this composes
    the references into a NEW frame rather than repainting one of them, which is
    the `r2i` role Krea2EditRebalance fills for Krea 2.

    Qwen is a flow model, so it wants ModelSamplingAuraFlow's shift; CFGNorm
    keeps the higher cfg (2.5, unlike the turbo models' 1.0) from burning.
    """
    steps = int(steps or qe.get("steps", 20))
    cfg = float(cfg if cfg is not None else qe.get("cfg", 2.5))
    stack = _norm_loras(loras, default_strength=qe.get("lora_strength", 1.0))
    g = {
        "1": _unet_loader(qe["unet"]),
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": qe["text_encoder"], "type": "qwen_image",
                         "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": qe["vae"]}},
        "6": {"class_type": "EmptySD3LatentImage",
              "inputs": {"width": int(width), "height": int(height), "batch_size": 1}},
    }
    model_src = _lora_chain(g, ["1", 0], stack)
    g["4"] = {"class_type": "ModelSamplingAuraFlow",
              "inputs": {"model": model_src, "shift": float(qe.get("shift", 3.1))}}
    g["5"] = {"class_type": "CFGNorm",
              "inputs": {"model": ["4", 0], "strength": float(qe.get("cfg_norm", 1.0))}}

    # A NEGATIVE reference: a picture to compose AWAY from.
    #
    # This is the only image family in the studio that can express one. CFG is
    # a difference between two conditionings, so a negative reference needs a
    # negative branch that (a) exists and (b) is actually evaluated — Krea 2
    # and its finetunes are turbo at cfg 1.0 into a ConditioningZeroOut, H3
    # conditions inside its latent builder and has no negative at all
    # (h3_image_graph literally discards the argument), and LTX 2.5's distilled
    # recipe collapses to single-CFG at cfg 1. Qwen-Edit runs at 2.5 with
    # CFGNorm and hands the same references to both encoders, so appending one
    # picture to the NEGATIVE side only makes it a pure "not like this" vector:
    # everything both sides share cancels, and what is left is the difference.
    #
    # That cancellation is why the positive set is TRIMMED rather than the
    # negative merely extended. The node ceiling is three images; if the
    # positive already fills it, the negative can only carry the extra picture
    # by evicting one of the shared ones, and the differential silently becomes
    # "away from the previous panel AND toward the evicted reference" — a
    # muddle that would look like a weak effect rather than a wrong one.
    neg_extra = [n for n in (negative_refs or []) if n]
    pos_refs = list(refs or [])
    if neg_extra:
        keep = max(0, 3 - len(neg_extra))
        if len(pos_refs) > keep:
            print(f"[graphs] qwen negative refs: dropping {len(pos_refs) - keep} "
                  f"positive reference(s) to keep the differential clean", flush=True)
        pos_refs = pos_refs[:keep]
    neg_refs = pos_refs + neg_extra[:3]

    names = list(dict.fromkeys(pos_refs + neg_refs))[:6]
    for i, name in enumerate(names):
        g[str(20 + i)] = {"class_type": "LoadImage", "inputs": {"image": name}}
    slot = {name: str(20 + i) for i, name in enumerate(names)}

    # image1..image3 — the node's ceiling, and the first is the one it anchors on.
    def encode(node_id, text, images):
        ins = {"clip": ["2", 0], "prompt": text, "vae": ["3", 0]}
        for i, name in enumerate(images[:3]):
            ins[f"image{i + 1}"] = [slot[name], 0]
        g[node_id] = {"class_type": "TextEncodeQwenImageEditPlus",
                      "inputs": _fit_node_inputs(ins, node_spec)}

    encode("7", prompt, pos_refs)
    encode("8", negative, neg_refs)

    g["9"] = {"class_type": "KSampler",
              "inputs": {"model": ["5", 0], "seed": int(seed), "steps": steps, "cfg": cfg,
                         "sampler_name": qe.get("sampler", "euler"),
                         "scheduler": qe.get("scheduler", "simple"),
                         "positive": ["7", 0], "negative": ["8", 0],
                         "latent_image": ["6", 0], "denoise": 1.0}}
    g["10"] = {"class_type": "VAEDecode", "inputs": {"samples": ["9", 0], "vae": ["3", 0]}}
    g["11"] = {"class_type": "SaveImage",
               "inputs": {"images": ["10", 0], "filename_prefix": "neon/qwenedit"}}
    return g


def qwen_upscale_graph(qe, image, seed, *, prompt="", negative="", scale=2.0,
                       upscale_model="4xNomos8kDAT.safetensors", denoise=0.2, steps=None,
                       cfg=None, tile=1024, loras=None, node_spec=None, usdu_spec=None):
    """Tile-refine upscale: an ESRGAN-family enlarge, then a low-denoise pass
    over the result in tiles, through the model that made the image.

    The technique comes from a published Qwen-Edit upscaler workflow which —
    despite its name — contains no Qwen node at all: it runs an unrelated
    Flux finetune as the tile refiner. The refiner does not have to be that,
    and here it deliberately is not. Qwen-Edit is already on disk,
    it is what produced the image being refined, and using it costs one custom
    node plus a 300MB upscale model instead of a second ~20GB checkpoint.

    Why an upscale model AND a diffusion pass: `4xNomos8kDAT` enlarges without
    inventing anything, which is what you want for edges and text but leaves
    surfaces plasticky. The low-denoise tile pass puts grain and micro-detail
    back. `denoise` is the whole control — 0.2 refines, and much above ~0.35 the
    tiles start inventing content that disagrees across seams.

    `tile` is 1024 rather than the source workflow's 512: that was sized for
    Flux on a small card, and larger tiles mean fewer seams to fix on a 96GB
    box. UltimateSDUpscale does its own sampling per tile, so it takes the
    model/conditioning/vae and there is no KSampler or latent here at all.

    Requires ssitu/ComfyUI_UltimateSDUpscale — checked by the caller so a
    missing pack is an installable hint, not a graph validation error.

    TWO specs, and they are not interchangeable: `node_spec` is
    TextEncodeQwenImageEditPlus's (same meaning as in `qwen_edit_graph`) and
    `usdu_spec` is UltimateSDUpscale's. `_fit_node_inputs` DROPS keys the spec
    does not declare, so passing one spec for both strips `clip` and `prompt`
    off the encoders and ComfyUI rejects the graph for missing required inputs.
    """
    steps = int(steps or qe.get("steps", 20))
    cfg = float(cfg if cfg is not None else qe.get("cfg", 2.5))
    stack = _norm_loras(loras, default_strength=qe.get("lora_strength", 1.0))
    g = {
        "1": _unet_loader(qe["unet"]),
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": qe["text_encoder"], "type": "qwen_image",
                         "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": qe["vae"]}},
        "12": {"class_type": "LoadImage", "inputs": {"image": image}},
        "13": {"class_type": "UpscaleModelLoader",
               "inputs": {"model_name": upscale_model}},
    }
    model_src = _lora_chain(g, ["1", 0], stack)
    g["4"] = {"class_type": "ModelSamplingAuraFlow",
              "inputs": {"model": model_src, "shift": float(qe.get("shift", 3.1))}}
    g["5"] = {"class_type": "CFGNorm",
              "inputs": {"model": ["4", 0], "strength": float(qe.get("cfg_norm", 1.0))}}

    # No refs: this is a refine of one supplied image, not a composition. The
    # encoder is still the Edit-Plus node because that is what this checkpoint's
    # conditioning expects — it simply gets no image1.
    for nid, text in (("7", prompt), ("8", negative)):
        g[nid] = {"class_type": "TextEncodeQwenImageEditPlus",
                  "inputs": _fit_node_inputs(
                      {"clip": ["2", 0], "prompt": text, "vae": ["3", 0]}, node_spec)}

    g["14"] = {"class_type": "UltimateSDUpscale", "inputs": _fit_node_inputs({
        "image": ["12", 0], "model": ["5", 0], "positive": ["7", 0],
        "negative": ["8", 0], "vae": ["3", 0], "upscale_model": ["13", 0],
        "upscale_by": float(scale), "seed": int(seed), "steps": steps, "cfg": cfg,
        "sampler_name": qe.get("sampler", "euler"),
        "scheduler": qe.get("scheduler", "simple"),
        "denoise": float(denoise),
        "mode_type": "Linear", "tile_width": int(tile), "tile_height": int(tile),
        "mask_blur": 8, "tile_padding": 32,
        # Seam fixing off: with 1024 tiles there are few seams, and the fix pass
        # is a second diffusion over every boundary — it costs more than it
        # buys here. Turn it on if wide flat gradients band at the joins.
        "seam_fix_mode": "None", "seam_fix_denoise": 1.0, "seam_fix_width": 64,
        "seam_fix_mask_blur": 8, "seam_fix_padding": 16,
        "force_uniform_tiles": True, "tiled_decode": False,
    }, usdu_spec)}
    g["15"] = {"class_type": "SaveImage",
               "inputs": {"images": ["14", 0], "filename_prefix": "neon/upscale"}}
    return g


ANIMA_NEGATIVE = "worst quality, low quality, blurry, jpeg artifacts, sepia"


def anima_graph(am, prompt, seed, width, height, *, negative=None, steps=None,
                cfg=None, loras=None, style_lora=None, lora_strength=None):
    """Anima text->image — the API form of ComfyUI's own image_anima_base_v1
    template, which is what `hikari-anima` (an Anima v1.0 finetune) runs on.

    Anima is a base family of its own, not an SDXL finetune: a 4GB bf16 UNET
    that conditions through Qwen3-0.6B-*base* (CLIPLoader type "stable_diffusion"
    — the template's value, not a guess) and decodes through the Qwen image VAE
    we already fetch for Krea 2 and Qwen-Edit. Stock loaders throughout, so
    unlike the Krea 2 reference path there is no custom node that can be absent.

    Two things separate it from every other local image model here:

    1. It is NOT distilled. 30 steps at cfg 4.0, so the negative branch is
       actually evaluated — this is the one local family that takes a real
       negative prompt, where the Krea 2 turbo entries run cfg 1.0 and feed a
       ConditioningZeroOut. `am["negative"]` carries the default.
    2. It samples from `EmptyLatentImage`, not `EmptySD3LatentImage`. That is
       the template's node, and the latent channel count has to match what the
       UNET expects — do not "fix" this to match the Krea 2 builders because
       they share a VAE.

    The template's stock negative also lists score_1/score_2/score_3; those are
    Pony-family score tags and Hikari Anima specifically trained the quality
    tags out, so they are dropped from the default here.
    """
    steps = int(steps or am.get("steps", 30))
    cfg = float(cfg if cfg is not None else am.get("cfg", 4.0))
    neg = negative if negative is not None else am.get("negative", ANIMA_NEGATIVE)
    stack = _norm_loras(loras, style_lora, lora_strength, am.get("lora_strength", 1.0))
    g = {
        "1": _unet_loader(am["unet"]),
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": am["text_encoder"],
                         "type": am.get("clip_type", "stable_diffusion"),
                         "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": am["vae"]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": neg}},
        "6": {"class_type": "EmptyLatentImage",
              "inputs": {"width": int(width), "height": int(height), "batch_size": 1}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage",
              "inputs": {"images": ["8", 0], "filename_prefix": "neon/anima"}},
    }
    model_out = _lora_chain(g, ["1", 0], stack)
    g["7"] = {"class_type": "KSampler",
              "inputs": {"model": model_out, "seed": int(seed), "steps": steps, "cfg": cfg,
                         "sampler_name": am.get("sampler", "euler"),
                         "scheduler": am.get("scheduler", "simple"),
                         "positive": ["4", 0], "negative": ["5", 0],
                         "latent_image": ["6", 0], "denoise": 1.0}}
    return g


def flux_kontext_graph(fm, instruction, src_image, seed):
    """Edit an existing image with Flux.1 Kontext — the follow-up path for
    reference candidates. The source image is conditioning (ReferenceLatent),
    so the edit keeps the subject and changes only what's asked."""
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": fm["kontext"], "weight_dtype": "default"}},
        "2": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": fm["t5"], "clip_name2": fm["clip_l"], "type": "flux", "device": "cpu"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": fm["vae"]}},
        "4": {"class_type": "LoadImage", "inputs": {"image": src_image}},
        "5": {"class_type": "FluxKontextImageScale", "inputs": {"image": ["4", 0]}},
        "6": {"class_type": "VAEEncode", "inputs": {"pixels": ["5", 0], "vae": ["3", 0]}},
        "7": {"class_type": "CLIPTextEncodeFlux", "inputs": {"clip": ["2", 0], "clip_l": instruction, "t5xxl": instruction, "guidance": 2.5}},
        "8": {"class_type": "ReferenceLatent", "inputs": {"conditioning": ["7", 0], "latent": ["6", 0]}},
        "9": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["7", 0]}},
        "10": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "seed": int(seed), "steps": 20, "cfg": 1.0,
               "sampler_name": "euler", "scheduler": "simple", "positive": ["8", 0], "negative": ["9", 0],
               "latent_image": ["6", 0], "denoise": 1.0}},
        "11": {"class_type": "VAEDecode", "inputs": {"samples": ["10", 0], "vae": ["3", 0]}},
        "12": {"class_type": "SaveImage", "inputs": {"images": ["11", 0], "filename_prefix": "qamba/ref_edit"}},
    }


# ================================================================== music ====
# Two text-to-music models, both native ComfyUI (no custom node, so unlike the
# Krea 2 reference path there is nothing here that can be absent). Both graphs
# are transcriptions of the official templates in
# comfyui-workflow-templates — `audio_minimax_music_3.json` and
# `audio_ace_step_1_5_split.json` — kept in API format.
#
# The shared shape is: loaders -> text encode -> ConditioningZeroOut for the
# negative -> an empty AUDIO latent sized in SECONDS -> KSampler -> a
# VAEDecodeAudio -> SaveAudioMP3. What differs is where the length comes from,
# and that difference is the one thing worth reading twice (see each builder).

MUSIC_SAVE_PREFIX = "audio/qamba_music"


def _music_decode(g, sampler_id, vae_id, *, tiled=False, tile_size=1536, overlap=64):
    """Decode the audio latent, tiled or not; returns the new node id.

    Tiled decode trades a little seam risk for a much smaller activation peak,
    which is what makes a 5-minute track decodable at all on a smaller card.
    On 96GB it is off by default — the plain decoder is one node and no seams.
    """
    if tiled:
        g["9"] = {"class_type": "VAEDecodeAudioTiled",
                  "inputs": {"samples": [sampler_id, 0], "vae": [vae_id, 0],
                             "tile_size": int(tile_size), "overlap": int(overlap)}}
    else:
        g["9"] = {"class_type": "VAEDecodeAudio",
                  "inputs": {"samples": [sampler_id, 0], "vae": [vae_id, 0]}}
    return "9"


def music3_graph(mm, *, caption, lyrics="", seconds=60.0, seed=0, steps=None,
                 cfg=None, lm_cfg=None, top_k=None, tiled=False,
                 quality="V0", node_spec=None):
    """MiniMax Music 3 — caption + lyrics -> a full song with vocals.

    THE LENGTH IS NOT A NUMBER WE SET. `MiniMaxMusic3TextEncode` returns
    (CONDITIONING, FLOAT), and that FLOAT — the duration its planner actually
    chose, having read the lyrics — is what the official template feeds to
    `EmptyMiniMaxMusic3LatentAudio.seconds`. `max_duration` is a CEILING the
    model may finish under, so writing our own number into the latent instead
    would size the canvas for a song the planner never wrote: the tail is
    whatever the DiT puts in the space left over. Hence the link below, and
    hence `max_duration` rather than `duration` in this signature.

    `mm` is the model_map `music_models` entry.
    """
    steps = int(steps if steps is not None else mm.get("steps", 30))
    cfg = float(cfg if cfg is not None else mm.get("cfg", 1.7))
    lm_cfg = float(lm_cfg if lm_cfg is not None else mm.get("lm_cfg", cfg))
    top_k = int(top_k if top_k is not None else mm.get("top_k", 50))
    seconds = float(seconds)

    enc = {"clip": ["3", 0], "caption": caption or "", "lyrics": lyrics or "",
           "seed": int(seed), "max_duration": seconds,
           "cfg_scale": lm_cfg, "top_k": top_k}
    g = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": mm["unet"], "weight_dtype": "default"}},
        "3": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": mm["text_encoder"],
                         "type": mm.get("clip_type", "minimax"),
                         "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": mm["vae"]}},
        "5": {"class_type": "MiniMaxMusic3TextEncode",
              "inputs": _fit_node_inputs(enc, (node_spec or {}).get("MiniMaxMusic3TextEncode"))},
        "6": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["5", 0]}},
        # slot 1 of the encoder = the planned duration. See the docstring.
        "7": {"class_type": "EmptyMiniMaxMusic3LatentAudio",
              "inputs": {"seconds": ["5", 1], "batch_size": 1}},
        "8": {"class_type": "KSampler",
              "inputs": {"model": ["1", 0], "seed": int(seed), "steps": steps,
                         "cfg": cfg, "sampler_name": mm.get("sampler", "euler"),
                         "scheduler": mm.get("scheduler", "simple"),
                         "positive": ["5", 0], "negative": ["6", 0],
                         "latent_image": ["7", 0], "denoise": 1.0}},
    }
    dec = _music_decode(g, "8", "4", tiled=tiled)
    g["10"] = {"class_type": "SaveAudioMP3",
               "inputs": {"audio": [dec, 0], "filename_prefix": MUSIC_SAVE_PREFIX,
                          "quality": quality}}
    return {"graph": g, "outputs": ["10"]}


def acestep_graph(mm, *, tags, lyrics="", seconds=120.0, seed=0, steps=None,
                  cfg=None, shift=None, bpm=120, key_scale="C major",
                  time_signature="4", language="en", generate_audio_codes=True,
                  lm_cfg=None, temperature=0.85, top_p=0.9, top_k=0, min_p=0.0,
                  tiled=False, quality="V0", node_spec=None):
    """ACE-Step 1.5 — tags + lyrics -> a song, in 8 steps on the turbo rows.

    THE LENGTH IS SET TWICE, ON PURPOSE. The official template wires one
    primitive into both `TextEncodeAceStepAudio1.5.duration` and
    `EmptyAceStep1.5LatentAudio.seconds`; the encoder's copy is what the 5Hz
    LM plans its audio codes against, the latent's copy is the canvas. They
    are the same value here for exactly that reason — feeding the encoder 60
    and the latent 120 gives you a minute of song and a minute of whatever
    fills the rest, which is the ACE-Step equivalent of the Music 3 note above.

    `generate_audio_codes` runs the LM half. On (the default) it is slower and
    better structured; off is faster and, per the node's own tooltip, the right
    setting when the model is given an audio reference. Turning it off also
    widens genre variety, which is the community's reason for the toggle.

    Musical metadata (bpm / key / time signature / language) is NOT decoration:
    these are typed inputs the encoder conditions on, so they are separated
    from the free-text tags rather than being written into them.
    """
    steps = int(steps if steps is not None else mm.get("steps", 8))
    cfg = float(cfg if cfg is not None else mm.get("cfg", 1.0))
    shift = float(shift if shift is not None else mm.get("shift", 3.0))
    lm_cfg = float(lm_cfg if lm_cfg is not None else mm.get("lm_cfg", 2.0))
    seconds = float(seconds)

    tes = list(mm.get("text_encoders") or ([mm["text_encoder"]] if mm.get("text_encoder") else []))
    ctype = mm.get("clip_type", "ace")
    if len(tes) >= 2:
        # The 0.6b embedder conditions the DiT; the 1.7b/4b 5Hz LM plans the
        # audio codes. A DualCLIPLoader slot left empty is a different model,
        # not a smaller one — so a one-file entry loads through CLIPLoader
        # instead of quietly repeating a filename into both slots.
        clip = {"class_type": "DualCLIPLoader",
                "inputs": {"clip_name1": tes[0], "clip_name2": tes[1],
                           "type": ctype, "device": "default"}}
    else:
        clip = {"class_type": "CLIPLoader",
                "inputs": {"clip_name": tes[0], "type": ctype, "device": "default"}}

    enc = {"clip": ["3", 0], "tags": tags or "", "lyrics": lyrics or "",
           "seed": int(seed), "bpm": int(bpm), "duration": seconds,
           "timesignature": str(time_signature), "language": language,
           "keyscale": key_scale,
           "generate_audio_codes": bool(generate_audio_codes),
           "cfg_scale": lm_cfg, "temperature": float(temperature),
           "top_p": float(top_p), "top_k": int(top_k), "min_p": float(min_p)}
    g = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": mm["unet"], "weight_dtype": "default"}},
        "2": {"class_type": "ModelSamplingAuraFlow",
              "inputs": {"model": ["1", 0], "shift": shift}},
        "3": clip,
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": mm["vae"]}},
        "5": {"class_type": "TextEncodeAceStepAudio1.5",
              "inputs": _fit_node_inputs(enc, (node_spec or {}).get("TextEncodeAceStepAudio1.5"))},
        "6": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["5", 0]}},
        "7": {"class_type": "EmptyAceStep1.5LatentAudio",
              "inputs": {"seconds": seconds, "batch_size": 1}},
        "8": {"class_type": "KSampler",
              "inputs": {"model": ["2", 0], "seed": int(seed), "steps": steps,
                         "cfg": cfg, "sampler_name": mm.get("sampler", "euler"),
                         "scheduler": mm.get("scheduler", "simple"),
                         "positive": ["5", 0], "negative": ["6", 0],
                         "latent_image": ["7", 0], "denoise": 1.0}},
    }
    dec = _music_decode(g, "8", "4", tiled=tiled)
    g["10"] = {"class_type": "SaveAudioMP3",
               "inputs": {"audio": [dec, 0], "filename_prefix": MUSIC_SAVE_PREFIX,
                          "quality": quality}}
    return {"graph": g, "outputs": ["10"]}


SFX_SAVE_PREFIX = "audio/qamba_sfx"


def stable_audio_graph(mm, *, prompt, negative="", seconds=10.0, seed=0,
                       steps=None, cfg=None, tiled=False, quality="V0"):
    """Stable Audio 3 — a written description -> stereo audio (SFX, foley,
    one-shots, beds). The API form of ComfyUI's `audio_stable_audio_3_*`
    templates.

    No `node_spec` here, unlike the two music builders: every node in this
    graph is long-settled core (`CheckpointLoaderSimple`, `CLIPTextEncode`,
    `EmptyLatentAudio`, `KSampler`), so there is no young signature to fit to.

    Three ways this differs from the two music builders above, all structural:

    * **The checkpoint is one file, not three.** `CheckpointLoaderSimple`
      returns MODEL and VAE together, so there is no `UNETLoader`/`VAELoader`
      pair — but the CLIP it also returns is NOT the conditioner. The
      conditioner is t5gemma, loaded separately at `type: "stable_audio"`,
      exactly as the template does.
    * **The negative branch is real.** This samples at cfg 7, so the negative
      is a second text encode rather than the `ConditioningZeroOut` the music
      builders use — those are turbo rows at cfg 1.0, where a negative can
      never contribute. `payload.negative` therefore does something here and
      provably nothing there. Same rule as Anima on the image side.
    * **The length is ours to set.** Music 3's planner chooses its own and
      ACE-Step wants the same number in two places; here `seconds` on the
      empty latent is the entire duration contract, which is what an SFX
      needs — it is asked for at an exact length because it has to land in a
      cut.

    The template's Qwen "reprompt" half is deliberately absent: expanding a
    short idea into a detailed prompt is what `api/director/enhance` and the
    prompt guides already do, at the layer that can show the user the result
    before it is rendered. Doing it inside the graph would put an LLM on the
    far side of invariant #1 and hide the text that was actually used.
    """
    steps = int(steps if steps is not None else mm.get("steps", 50))
    cfg = float(cfg if cfg is not None else mm.get("cfg", 7.0))
    seconds = float(seconds)

    g = {
        "1": {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": mm["checkpoint"]}},
        "3": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": mm["text_encoder"],
                         "type": mm.get("clip_type", "stable_audio"),
                         "device": "default"}},
        "5": {"class_type": "CLIPTextEncode",
              "inputs": {"clip": ["3", 0], "text": prompt or ""}},
        "6": {"class_type": "CLIPTextEncode",
              "inputs": {"clip": ["3", 0], "text": negative or ""}},
        "7": {"class_type": "EmptyLatentAudio",
              "inputs": {"seconds": seconds, "batch_size": 1}},
        "8": {"class_type": "KSampler",
              "inputs": {"model": ["1", 0], "seed": int(seed), "steps": steps,
                         "cfg": cfg, "sampler_name": mm.get("sampler", "lcm"),
                         "scheduler": mm.get("scheduler", "simple"),
                         "positive": ["5", 0], "negative": ["6", 0],
                         "latent_image": ["7", 0], "denoise": 1.0}},
    }
    # The VAE rides on the checkpoint — slot 2 of the loader, not a VAELoader.
    dec = _music_decode(g, "8", "1", tiled=tiled)
    g[dec]["inputs"]["vae"] = ["1", 2]
    g["10"] = {"class_type": "SaveAudioMP3",
               "inputs": {"audio": [dec, 0], "filename_prefix": SFX_SAVE_PREFIX,
                          "quality": quality}}
    return {"graph": g, "outputs": ["10"]}


# --------------------------------------------------- video -> audio (MMAudio)
V2A_SAVE_PREFIX = "audio/qamba_v2a"

# THE FRAME RATE IS THE CONTRACT, and it is the one number in this builder that
# cannot be chosen freely. Kijai's port hands the sampler ONE image batch and
# `process_video_tensor` slices it twice — `[:8*duration]` for the CLIP
# semantic tower and `[:25*duration]` for Synchformer — then, crucially:
#
#     if total_frames < sync_frames_count:
#         duration_sec = total_frames / _SYNC_FPS
#
# So a batch shorter than 25 x duration silently SHORTENS the render. Stage an
# 8s shot at its native 24fps (192 frames) and an 8.0s request comes back as
# 7.68s of audio, with nothing but a `log.warning` inside ComfyUI to say so —
# and a soundtrack that stops before the picture is exactly the defect this
# whole path exists to remove. force_rate 25 makes the batch 25 x duration
# exactly, so the requested length is always the delivered length.
#
# The honest cost, stated because it is invisible in the output: at 25fps the
# CLIP branch's `[:8*duration]` slice is the first 8/25 of the batch, i.e. the
# first ~32% of the shot. Synchformer — the branch MMAudio is actually
# celebrated for, and the one that decides whether a footstep lands on the
# frame the foot lands on — sees all of it at its own native rate. Feeding 8fps
# instead would invert that trade AND cut the duration to a third, so this is
# the only rate that keeps the length contract. The text prompt is what carries
# semantics for the back two thirds, which is why this path always sends one.
V2A_SYNC_FPS = 25


def mmaudio_graph(mm, *, video, prompt, negative="", seconds=8.0, seed=0,
                  steps=None, cfg=None, mask_away_clip=False, load_cap=0,
                  skip_frames=0, node_spec=None, feature_spec=None,
                  sampler_spec=None):
    """MMAudio — a silent video plus a written description -> a synchronised
    soundtrack. The API form of the pack's own `mmaudio_test` workflow.

    A FIFTH generation family, beside image / video / music / sfx, and the
    first one whose input is a VIDEO. That is what makes it a different job
    from `sfx_gen` rather than a family inside it: Stable Audio writes a sound
    from a caption and has no idea what is on screen, while this conditions on
    the frames — so the length comes from the clip, the prompt supplements the
    picture rather than describing the whole event, and the useful output is
    a track that lines up with a cut.

    Four nodes, all from kijai/ComfyUI-MMAudio:

    * `MMAudioModelLoader`     -> MMAUDIO_MODEL      (the 2GB flow transformer)
    * `MMAudioFeatureUtilsLoader` -> MMAUDIO_FEATUREUTILS
        (audio VAE + Synchformer + the DFN5B CLIP tower, in one object)
    * `MMAudioSampler`         -> AUDIO
    * `MMAudioVoCoderLoader`   — deliberately ABSENT. It only exists for the
        16k branch, which `assert`s a vocoder input; at 44k the FeatureUtils
        loader snapshot-downloads nvidia/bigvgan_v2_44khz_128band_512x into
        `models/mmaudio/nvidia/` on first use and wires it itself. Adding the
        node would mean shipping 16k weights we do not have.

    Every loader reads its dropdown from the single `models/mmaudio` folder the
    pack registers, which is why `resolve._v2a_files` puts four files that
    ComfyUI would normally scatter across four directories into one.

    The specs are fitted (`_fit_node_inputs`), same as `Krea2EditRebalance` and
    for the same reason — this pack's own README says "WIP WIP WIP", so its
    signature is the youngest in the studio. `spec=None` keeps the caller's
    shape so the builder stays unit-testable with no ComfyUI running.
    """
    steps = int(steps if steps is not None else mm.get("steps", 25))
    cfg = float(cfg if cfg is not None else mm.get("cfg", 4.5))
    seconds = float(seconds)
    fps = int(mm.get("sync_fps") or V2A_SYNC_FPS)

    g = {}

    # `frame_load_cap` is bounded to what the sampler will actually read
    # (fps x duration): decoding a 3-minute source to condition an 8-second
    # render is minutes of CPU and gigabytes of RAM for frames the node
    # discards on its first line. 0 from the caller means "the whole file",
    # which is right for a block take (already trimmed to its content) and
    # wrong for a timeline clip whose file runs past the trim — the same
    # distinction `_wire_motion_context` documents.
    want_frames = int(round(fps * seconds))
    cap = int(load_cap) if load_cap else want_frames
    g["1"] = {"class_type": "VHS_LoadVideo", "inputs": {
        "video": video, "force_rate": fps,
        "custom_width": 0, "custom_height": 0,
        "frame_load_cap": max(1, cap),
        "skip_first_frames": int(skip_frames or 0), "select_every_nth": 1}}

    g["2"] = {"class_type": "MMAudioModelLoader",
              "inputs": _fit_node_inputs(
                  {"mmaudio_model": mm["model"],
                   "base_precision": mm.get("precision", "fp16")}, node_spec)}

    g["3"] = {"class_type": "MMAudioFeatureUtilsLoader",
              "inputs": _fit_node_inputs(
                  {"vae_model": mm["vae"],
                   "synchformer_model": mm["synchformer"],
                   "clip_model": mm["clip"],
                   "mode": mm.get("mode", "44k"),
                   "precision": mm.get("precision", "fp16")}, feature_spec)}

    g["4"] = {"class_type": "MMAudioSampler",
              "inputs": _fit_node_inputs(
                  {"mmaudio_model": ["2", 0], "feature_utils": ["3", 0],
                   "images": ["1", 0],
                   "duration": seconds, "steps": steps, "cfg": cfg,
                   "seed": int(seed) & 0xffffffffffffffff,
                   "prompt": prompt or "", "negative_prompt": negative or "",
                   # `mask_away_clip` drops the CLIP tower and leaves only
                   # Synchformer's timing plus the text. It is the knob for
                   # "the picture is misleading the sound" — a stylised or
                   # very dark shot — not a default.
                   "mask_away_clip": bool(mask_away_clip),
                   "force_offload": True}, sampler_spec)}

    g["5"] = {"class_type": "SaveAudioMP3",
              "inputs": {"audio": ["4", 0],
                         "filename_prefix": V2A_SAVE_PREFIX, "quality": "V0"}}
    return {"graph": g, "outputs": ["5"]}


# ----------------------------------------------------------- post chain ------
# The finishing passes handlers/post.py applies to a clip. Builders rather than
# workflow files (the shape handle_image_upscale already uses) because each one
# is conditional in a way string substitution cannot express — an optional
# reference image, an optional latent upsample, a frame count that has to be
# computed. workflows/post_seedvr2.json and post_rife.json were the file form
# and they were written against node names this pod does not have.
#
# THE PACKS THEY WAITED FOR ARE NOT NEEDED. Verified against the live pod
# 2026-08-23: SeedVR2 is CORE (comfy_extras/nodes_seedvr.py, ComfyUI v0.28.0,
# PR #14424) and frame interpolation is CORE (nodes_frame_interpolation.py,
# with its own `frame_interpolation` model folder). The repo named numz's
# SeedVR2 pack and ComfyUI-Frame-Interpolation's `RIFE VFI`; both were absent,
# both were third-party, and neither has been required since core absorbed the
# feature. What was actually missing was the WEIGHTS — see the engine window's model list's
# `post` target.

#: VAE tiling for the SeedVR2 round trip, from ComfyUI's own template. Tiling
#: is not optional at video resolutions: the encode is over every frame at
#: once, and a 12s clip at 1280x704 does not fit un-tiled.
_SV2_TILE = {"tile_size": 512, "overlap": 128, "temporal_size": 64, "temporal_overlap": 8}

#: SeedVR2 checkpoints, addressed by KEY. Filenames never reach the browser —
#: the same convention `style_loras` follows, and for the same reason: a
#: settings row holding a filename is a render that dies inside ComfyUI on an
#: enum the moment the file on the box is renamed or was never fetched.
#:
#: All of these are Comfy-Org/SeedVR2 repacks in the int8_convrot quantisation
#: this pod already runs H3 and LTX 2.5 in — so 7B is a the engine window's model list
#: seedvr2-7b and a key, with no graph change at all: `seedvr2_graph` has
#: always taken `model=`.
#:
#: `sharp` is ByteDance's own second 7B checkpoint (`seedvr2_ema_7b_sharp`),
#: not a setting — they publish the pair and describe it as the sharper of the
#: two. Kept as its own key rather than a flag because it is a different file.
#:
#: NOT SeedVR **1**. ByteDance-Seed/SeedVR-7B is the original paper's model:
#: raw `.pth`, multi-step, and superseded by SeedVR2's one-step distillation —
#: `UNETLoader` cannot read it and the one-step recipe below does not apply to
#: it. If it is ever wanted it is a different graph, not another row here.
SEEDVR2_MODELS = {
    "3b": "seedvr2_3b_int8_convrot.safetensors",
    "7b": "seedvr2_7b_int8_convrot.safetensors",
    "7b-sharp": "seedvr2_7b_sharp_int8_convrot.safetensors",
}
SEEDVR2_DEFAULT = "3b"


def seedvr2_graph(video, *, scale=2.0, seed=0,
                  model="seedvr2_3b_int8_convrot.safetensors",
                  vae="seedvr2_ema_vae_fp16.safetensors",
                  steps=1, cfg=1.0, sampler="euler", scheduler="simple",
                  denoise=1.0, color_correction="none",
                  filename_prefix="neon/seedvr2"):
    """SeedVR2 restore. Ported from ComfyUI's own
    `utility_seedvr2_3b_int8_upscale_video` template, which ships the graph as
    a subgraph — the node ids and defaults below are that subgraph's, read out
    of it rather than reconstructed from the docs page (which documents the
    model files and not the wiring).

    IT IS A ONE-STEP MODEL, and the sampler settings are the surprising part:
    steps=1, cfg=1.0, euler/simple, denoise=1.0. So this costs far less per
    second than a 3.5GB video model suggests, and anything that "improves" the
    step count is fighting the model rather than tuning it.

    THE ENLARGE IS A PLAIN RESIZE AND SEEDVR2 IS THE RESTORE AFTER IT. The
    picture is scaled up with lanczos FIRST and SeedVR2 re-detects detail at
    the target size — it is not a learned upsampler, which is why the op is
    described as a restore in postChain.ts and why running it at scale=1.0 is
    a legitimate thing to do (clean up a soft render without resizing it).

    `original_resized_images` on the post-processing node is the RESIZED input,
    not the source: it is the reference the colour correction matches back to,
    so it has to be the same geometry as the decode.

    ImageScaleBy rather than the template's `ResizeImageMaskNode`: that node
    carries its multiplier inside a DynamicCombo (`resize_type.multiplier`),
    which has no stable API-format spelling, where ImageScaleBy is core, plain
    and does the identical lanczos enlarge.
    """
    g = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": model, "weight_dtype": "default"}},
        "2": {"class_type": "VAELoader", "inputs": {"vae_name": vae}},
        "3": {"class_type": "LoadVideo", "inputs": {"file": video}},
        "4": {"class_type": "GetVideoComponents", "inputs": {"video": ["3", 0]}},
        "5": {"class_type": "ImageScaleBy",
              "inputs": {"image": ["4", 0], "upscale_method": "lanczos",
                         "scale_by": float(scale)}},
        "6": {"class_type": "SeedVR2Preprocess", "inputs": {"resized_images": ["5", 0]}},
        "7": {"class_type": "VAEEncodeTiled",
              "inputs": dict(pixels=["6", 0], vae=["2", 0], **_SV2_TILE)},
        "8": {"class_type": "SeedVR2Conditioning",
              "inputs": {"model": ["1", 0], "vae_conditioning": ["7", 0]}},
        "9": {"class_type": "KSampler",
              "inputs": {"model": ["1", 0], "seed": int(seed), "steps": int(steps),
                         "cfg": float(cfg), "sampler_name": sampler,
                         "scheduler": scheduler, "positive": ["8", 0],
                         "negative": ["8", 1], "latent_image": ["7", 0],
                         "denoise": float(denoise)}},
        "10": {"class_type": "VAEDecodeTiled",
               "inputs": dict(samples=["9", 0], vae=["2", 0], **_SV2_TILE)},
        "11": {"class_type": "SeedVR2PostProcessing",
               "inputs": {"images": ["10", 0], "original_resized_images": ["5", 0],
                          "color_correction_method": color_correction}},
        # fps and audio ride straight through from the source, untouched — a
        # restore pass must not retime or re-encode the soundtrack.
        "12": {"class_type": "CreateVideo",
               "inputs": {"images": ["11", 0], "fps": ["4", 2], "audio": ["4", 1],
                          "bit_depth": ["4", 3]}},
        "13": {"class_type": "SaveVideo",
               "inputs": {"video": ["12", 0], "filename_prefix": filename_prefix,
                          "format": "auto", "codec": "auto"}},
    }
    return g


def frame_interp_graph(video, *, multiplier=2, fps=None,
                       model="film_net_fp16.safetensors",
                       filename_prefix="neon/interp"):
    """Frame interpolation over core's `FrameInterpolationModelLoader`.

    The loader SNIFFS the architecture out of the state dict — FILM by one key,
    RIFE by another, with the raw-checkpoint key remapping done for you — so
    there is no "which kind is this" setting to get wrong and `model` is just a
    filename. the engine window's model list pulls both; FILM is the default because it is
    what ComfyUI's own template picks and it holds up better on large motion,
    and rife_v4.26_heavy is there for when a long clip needs the speed.

    `fps` is the OUTPUT rate and the caller computes it (src_fps * multiplier),
    because the pass is only meaningful as "the same footage, more frames" —
    leaving the source rate on the output would slow the clip down instead.
    """
    out_fps = float(fps if fps is not None else 24.0 * multiplier)
    return {
        "1": {"class_type": "FrameInterpolationModelLoader",
              "inputs": {"model_name": model}},
        "2": {"class_type": "LoadVideo", "inputs": {"file": video}},
        "3": {"class_type": "GetVideoComponents", "inputs": {"video": ["2", 0]}},
        "4": {"class_type": "FrameInterpolate",
              "inputs": {"interp_model": ["1", 0], "images": ["3", 0],
                         "multiplier": int(multiplier)}},
        "5": {"class_type": "CreateVideo",
              "inputs": {"images": ["4", 0], "fps": out_fps, "audio": ["3", 1]}},
        "6": {"class_type": "SaveVideo",
              "inputs": {"video": ["5", 0], "filename_prefix": filename_prefix,
                         "format": "auto", "codec": "auto"}},
    }


#: The colour transfers the studio will build. A SUBSET of what the node
#: declares — see COLOR_MATCH_REFUSED — plus `vcg`, which is not the node's at
#: all (see VCG_* below). Everything but `vcg` is `color-matcher`'s, running on
#: the CPU over every frame; `reinhard_lab_gpu` is ColorMatchV2's Lab/GPU one.
COLOR_MATCH_METHODS = ("mkl", "hm", "reinhard", "mvgd", "hm-mkl-hm",
                       "reinhard_lab_gpu", "vcg")

#: DECLARED BY THE NODE AND DELIBERATELY NOT OFFERED, with the reason. Kept as
#: data rather than deleted, because the node goes on offering these and the
#: next person to read its combo list needs to know this was a decision.
#:
#: `hm-mvgd-hm` measured UNUSABLE on this studio's footage (2026-09-05): it
#: renders a face in coarse blotches with colour fringing on the hair. The
#: cause is the content — cel shading is large flat areas of few values, and
#: histogram matching quantises a sparse histogram hard. Note its gap-to-
#: reference score was COMPETITIVE, so the number does not catch this; its
#: correlation to source (0.965-0.987 against every other arm's 0.99+) is what
#: does. `hm` and `hm-mkl-hm` carry the same histogram stage and are NOT
#: refused — they are untested, and refusing on inference rather than on a
#: measurement is how a real option gets deleted by rumour.
COLOR_MATCH_REFUSED = {
    "hm-mvgd-hm": "posterises cel-shaded footage — measured on Rei EP03, "
                  "faces come back blotchy with fringing on the hair",
}

#: The learned-LUT grade: ICCV 2025 "Video Color Grading via Look-Up Table
#: Generation" through kijai/ComfyUI-VideoColorGrading. ONE combined
#: checkpoint (CLIP + VAE + ReferenceNet + L-Diffuser) in `checkpoints/`;
#: the engine window's model list vcg.
VCG_CHECKPOINT = "vcg_combined_fp16.safetensors"
VCG_STEPS = 25
#: FIXED, and that is the point: the LUT is generated per clip, so a seed that
#: varied per clip would put a different roll of the same grade on every shot
#: of one cut. 42 is the node's own default.
VCG_SEED = 42
VCG_NODES = ("VCGLoadModel", "VCGGenerateLUT", "VCGApplyLUT")

#: Methods only `ColorMatchV2` has. `reinhard_lab_gpu` is not a faster mkl —
#: it is a DIFFERENT correction: per-channel mean/std in Lab through Kornia,
#: on the GPU, where MKL is a linear transform fitted to the full colour
#: covariance. Cheaper and weaker; a look, not just a speed.
COLOR_MATCH_V2_ONLY = ("reinhard_lab_gpu",)

#: The node this pass renders on, newest first. `ColorMatch` carries
#: `DEPRECATED = True` in KJNodes and `ColorMatchV2` is the same algorithms on
#: the V3 schema; both take the same input NAMES, so one inputs dict serves
#: either and the order difference between them (V2 declares image_target
#: first) is irrelevant to an API graph.
COLOR_MATCH_NODES = ("ColorMatchV2", "ColorMatch")


def color_match_graph(video, reference, *, method="mkl", strength=1.0,
                      node="ColorMatch", multithread=True,
                      filename_prefix="neon/colormatch"):
    """Match a clip's grade to a reference STILL.

    KJNodes' `ColorMatch`, which is already on this pod — the pass was labelled
    as waiting for VRGDG's `ColorMatchToReference` and has never needed it.

    The reference is one image, not a video: these are global colour-transfer
    algorithms (mkl / hm / reinhard / mvgd), they take a target distribution,
    and one representative frame IS that distribution. The caller extracts it,
    which also means the reference can be an ordinary still asset.

    `mkl` is the default because it is the node's own and it moves the whole
    distribution rather than clipping it; `reinhard` is the gentler one when a
    match overshoots.

    `node` is the class, picked by the CALLER against the live engine
    (`post._color_match_node`) rather than here, because that decision needs
    /object_info and this module stays offline-buildable.

    STRENGTH AND MULTITHREAD ARE ALWAYS WRITTEN, and that is not cosmetic:
    they are OPTIONAL on v1 and REQUIRED on V2, so a graph that omitted them
    would validate on the node this pass shipped against and fail on the one
    it is moving to. `multithread` matches KJNodes' own Python default, so
    writing it changes nothing on either node — v1 renders exactly as it did.
    """
    return {
        "1": {"class_type": "LoadVideo", "inputs": {"file": video}},
        "2": {"class_type": "GetVideoComponents", "inputs": {"video": ["1", 0]}},
        "3": {"class_type": "LoadImage", "inputs": {"image": reference}},
        "4": {"class_type": node,
              "inputs": {"image_ref": ["3", 0], "image_target": ["2", 0],
                         "method": method, "strength": float(strength),
                         "multithread": bool(multithread)}},
        "5": {"class_type": "CreateVideo",
              "inputs": {"images": ["4", 0], "fps": ["2", 2], "audio": ["2", 1]}},
        "6": {"class_type": "SaveVideo",
              "inputs": {"video": ["5", 0], "filename_prefix": filename_prefix,
                         "format": "auto", "codec": "auto"}},
    }


def vcg_grade_graph(video, reference, *, strength=1.0, steps=VCG_STEPS,
                    seed=VCG_SEED, checkpoint=VCG_CHECKPOINT,
                    filename_prefix="neon/vcggrade"):
    """Grade a clip to a reference STILL through a generated 3D LUT.

    Same contract as `color_match_graph` — video in, video out, audio carried —
    so `apply_color_match` can pick between them on one setting and everything
    downstream (the chain, op_hash, the cache) is unchanged.

    What it does that the statistical transfers cannot: they fit the clip's
    whole distribution to the reference's with ONE global transform, so they
    can move level and spread and nothing else, and against a warm reference
    that drives every shot amber. This generates a 16^3 LUT, which maps
    different parts of the colour cube differently — measured as the only arm
    that puts the reference's look on a face while leaving the skin reading as
    lamplight and the blue hair streak blue.

    TWO THINGS THE WIRING HAS TO GET RIGHT, both measured:

    The LUT is applied to the node's own PREPROCESSED frames (its README says
    so, and that preprocess is MKL) — but `original_images` is the UNTOUCHED
    source, not that preprocess. Below strength 1.0 the node blends toward
    whatever it is given, and VCG's preprocess ends on a batch-wide min-max
    normalise that washes the picture out (gap-to-reference 0.072-0.129 where
    plain mkl is 0.002-0.010). Blending toward it makes half strength worse
    than either end; blending toward the source makes `strength` mean what it
    means on every other grade — 0 is ungraded, 1 is the full look.

    At exactly 1.0 the node skips the blend, so `original_images` is inert
    there and this only decides what a partial strength interpolates through.
    """
    return {
        "1": {"class_type": "LoadVideo", "inputs": {"file": video}},
        "2": {"class_type": "GetVideoComponents", "inputs": {"video": ["1", 0]}},
        "3": {"class_type": "LoadImage", "inputs": {"image": reference}},
        "4": {"class_type": "VCGLoadModel", "inputs": {"model_name": checkpoint}},
        "5": {"class_type": "VCGGenerateLUT",
              "inputs": {"vcg_pipeline": ["4", 0], "reference_image": ["3", 0],
                         "source_frames": ["2", 0], "steps": int(steps),
                         "seed": int(seed)}},
        "6": {"class_type": "VCGApplyLUT",
              "inputs": {"images": ["5", 0], "lut": ["5", 1],
                         "strength": float(strength),
                         "original_images": ["2", 0]}},
        "7": {"class_type": "CreateVideo",
              "inputs": {"images": ["6", 0], "fps": ["2", 2], "audio": ["2", 1]}},
        "8": {"class_type": "SaveVideo",
              "inputs": {"video": ["7", 0], "filename_prefix": filename_prefix,
                         "format": "auto", "codec": "auto"}},
    }


#: The refine half of LTX 2.5's own two-pass recipe (ltx25_t2v.json node 22),
#: used when the picture has just been latent-upsampled 2x and the new detail
#: has to be synthesised. Starting sigma 0.85 is a lot of denoise.
LTX_REFINE_SIGMAS_UPSCALE = "0.85, 0.7250, 0.4219, 0.0"
#: Same schedule walked in from a lower start, for refining at native size —
#: there is no new detail to invent, so a high start just re-decides the shot.
LTX_REFINE_SIGMAS_NATIVE = "0.55, 0.4219, 0.2000, 0.0"

#: NAMED RUNGS ON ONE SCHEDULE, so a caller can say how far to let the refine
#: travel without writing a sigma string. The middle two are ours (above); the
#: outer two are iiTzMYUNG's own recommendations from the H3 -> LTX 2.5 refine
#: workflow (civitai 2910804), whose note states the tradeoff in as many words:
#: a deeper start gives the sampler more freedom and a correspondingly higher
#: chance of drifting off the face and wardrobe the first pass established.
#:
#: `faithful` is the rung this studio did not have. Every schedule here starts
#: at or above 0.55, which is enough denoise to re-decide a shot — so "sharpen
#: this take without moving it" was not expressible, and that is exactly what
#: someone reaches for a refine over a restore to get.
#:
#: THE AUTHOR'S NUMBERS ARE RECOMMENDATIONS, NOT MEASUREMENTS. He states in the
#: same workflow that he "couldn't execute it to confirm node compatibility",
#: so treat the two new rungs as a starting point and A/B them before quoting a
#: quality claim off them.
LTX_REFINE_PRESETS = {
    "faithful": "0.35, 0.22, 0.12, 0.0",
    "native": LTX_REFINE_SIGMAS_NATIVE,
    "balanced": "0.7, 0.55, 0.3, 0.0",
    "sharp": LTX_REFINE_SIGMAS_UPSCALE,
}

#: A refine's decode is tiled once its output frame is this big. Below it a
#: plain VAEDecode is exact and free of seams; above it the decode is where a
#: refine runs out of memory, because the DECODE holds the whole frame where
#: the sampler holds a 32x-compressed latent. The threshold is a shade under
#: 1080p (1920x1080 = 2.07M), so the common delivery size still decodes whole.
LTX_REFINE_TILE_PX = 2_100_000

#: The refine's tiled-decode settings, from that workflow's node 221. Note
#: `temporal_size` 4096 is effectively "do not tile in TIME": a temporal seam
#: is a visible hitch in motion where a spatial one is a static edge the
#: overlap blends away, so the axis that is safe to cut is the spatial one.
_LTX_REFINE_TILE = {"tile_size": 768, "overlap": 64,
                    "temporal_size": 4096, "temporal_overlap": 32}


def ltx_refine_graph(lx, video, *, seed=0, upscale=False, target=None,
                     sigmas=None, tile=None,
                     prompt="", negative="", fps=24.0,
                     sampler="euler_ancestral", video_cfg=1.0, audio_cfg=1.0,
                     filename_prefix="neon/ltx_refine"):
    """LTX 2.5 as a video-to-video refiner — the SECOND pass of its own
    pipeline, run over footage instead of over a first pass.

    This needs nothing installed. Every node is already on this pod and so is
    every weight, including the x2 latent upsampler (the engine window's model list ltx25
    pulls `latent_upscale_models/`), because LTX 2.5's normal render is ALREADY
    two-pass: sample at half size, `LTXVLatentUpsampler`, refine. All that is
    new here is where the first latent comes from — a VAEEncode of real frames
    rather than a sampler.

    IT IS A GENERATIVE PASS, NOT A RESTORE, and that is the whole difference
    from `seedvr2_graph`. It runs the footage back through a 22B diffusion
    model, so it re-decides detail and will move the look — on H3 footage it is
    also cross-family. Reach for it when you want the shot resynthesised
    sharper; reach for SeedVR2 when the take must survive intact.

    THE PICTURE COMES FROM THE REFINE AND THE SOUND FROM THE SOURCE. LTX
    generates audio natively, so a graph that decoded the refined audio latent
    would quietly replace the take's soundtrack — the same trap
    `_splice_h3_refine` documents, arriving from the other side. The audio
    latent here exists ONLY because LTX samples a concatenated AV latent and
    the model conditions on it; `CreateVideo` is handed the source's own audio,
    untouched, straight off GetVideoComponents.

    The caller owns the frame grid (LTX is 8n+1) and the length: pad up to the
    grid before, trim back after. A refine may not change how long a clip is.

    THREE RESOLUTION MODES, and they are a switch rather than a stack:

    * neither argument — refine at the source's own size. Detail only.
    * `upscale=True` — LTX's own learned x2 latent upsampler. Highest quality
      per pixel and the ratio is FIXED at 2, because that is what the upsampler
      was trained for.
    * `target=(w, h)` — resize the decoded frames in PIXEL space (lanczos)
      BEFORE re-encoding, so any size and any aspect works. This is the mode
      that lets a refine run at the delivery frame instead of at 2x of whatever
      the take happened to be, and the chain then has nothing to throw away:
      `transcode_chain` caps every intermediate at 1080 tall and the body
      render fits to the timeline, so a 2x of a 1280x704 take was being
      resampled twice to arrive somewhere smaller than it started.

    Passing both raises. They are not composable — the upsampler is trained for
    one ratio, so pre-resizing and then upsampling is two resamples to reach a
    size neither of them was asked for. Adapted from iiTzMYUNG's H3 -> LTX 2.5
    refine workflow (civitai 2910804), which makes the same two paths a boolean
    switch for the same reason.

    THE DECODE TILES ABOVE ~1080p. The sampler works on a 32x-compressed latent
    and the decode holds the whole frame, so the decode is where a big refine
    runs out of memory — and `_windowed` cannot help, because it splits TIME
    and this is a per-frame limit. Spatial tiles only (see _LTX_REFINE_TILE): a
    seam in space is a static edge an overlap blends away, where a seam in time
    is a hitch in the motion.
    """
    if upscale and target:
        raise RuntimeError("ltx_refine: pass either upscale=True (the learned "
                           "x2 latent upsampler) or target=(w, h) (a pixel "
                           "resize), never both")
    if target:
        # Defensive snap only — the caller is expected to have computed an
        # on-grid, aspect-true target (see handlers.post.refine_target). LTX's
        # VAE downsamples by 32 and the entry declares its own step, so an
        # off-grid encode is a pad or an error deep inside the sampler.
        step = max(1, int(lx.get("dim_step") or 32))
        target = tuple(max(step, int(round(v / step)) * step) for v in target[:2])
    if sigmas is None:
        sigmas = LTX_REFINE_SIGMAS_UPSCALE if upscale else LTX_REFINE_SIGMAS_NATIVE
    sigmas = LTX_REFINE_PRESETS.get(sigmas, sigmas)
    if tile is None:
        tile = bool(upscale) or (bool(target)
                                 and target[0] * target[1] >= LTX_REFINE_TILE_PX)
    g = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": lx["modes"]["t2v"]["checkpoint"],
                         "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": lx["text_encoders"][0], "type": "ltxv",
                         "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": lx["vae"]}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": lx["audio_vae"]}},
        "6": {"class_type": "LoadVideo", "inputs": {"file": video}},
        "7": {"class_type": "GetVideoComponents", "inputs": {"video": ["6", 0]}},
        "8": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "9": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["2", 0]}},
        "10": {"class_type": "LTXVConditioning",
               "inputs": {"positive": ["8", 0], "negative": ["9", 0],
                          "frame_rate": float(fps)}},
        "11": {"class_type": "VAEEncode",
               "inputs": {"pixels": ["24", 0] if target else ["7", 0],
                          "vae": ["3", 0]}},
        "12": {"class_type": "LTXVAudioVAEEncode",
               "inputs": {"audio": ["7", 1], "audio_vae": ["4", 0]}},
    }
    if target:
        # Deliberately `crop: disabled` and no aspect lock: the caller decides
        # the shape, and a resize that quietly letterboxed or cropped here
        # would bake bars into a frame the body render is about to fit again.
        g["24"] = {"class_type": "ImageScale",
                   "inputs": {"image": ["7", 0], "upscale_method": "lanczos",
                              "width": int(target[0]), "height": int(target[1]),
                              "crop": "disabled"}}
    vid_latent = ["11", 0]
    if upscale:
        g["5"] = {"class_type": "LatentUpscaleModelLoader",
                  "inputs": {"model_name": lx["latent_upscaler"]}}
        g["13"] = {"class_type": "LTXVLatentUpsampler",
                   "inputs": {"samples": ["11", 0], "upscale_model": ["5", 0],
                              "vae": ["3", 0]}}
        vid_latent = ["13", 0]
    g["14"] = {"class_type": "LTXVConcatAVLatent",
               "inputs": {"video_latent": vid_latent, "audio_latent": ["12", 0]}}
    g["15"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": int(seed)}}
    g["16"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": sampler}}
    g["17"] = {"class_type": "ManualSigmas", "inputs": {"sigmas": sigmas}}
    # Both cfgs at 1.0, so LTXVDualCFGGuider collapses to single-CFG and the
    # negative encode is decorative — the distilled recipe's own behaviour, and
    # the reason the LTX rows declare no negativePrompt. It is wired anyway
    # because the node requires it.
    g["18"] = {"class_type": "LTXVDualCFGGuider",
               "inputs": {"model": ["1", 0], "positive": ["10", 0],
                          "negative": ["10", 1], "video_cfg": float(video_cfg),
                          "audio_cfg": float(audio_cfg)}}
    g["19"] = {"class_type": "SamplerCustomAdvanced",
               "inputs": {"noise": ["15", 0], "guider": ["18", 0],
                          "sampler": ["16", 0], "sigmas": ["17", 0],
                          "latent_image": ["14", 0]}}
    g["20"] = {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["19", 0]}}
    g["21"] = ({"class_type": "VAEDecodeTiled",
                "inputs": dict(samples=["20", 0], vae=["3", 0], **_LTX_REFINE_TILE)}
               if tile else
               {"class_type": "VAEDecode",
                "inputs": {"samples": ["20", 0], "vae": ["3", 0]}})
    g["22"] = {"class_type": "CreateVideo",
               "inputs": {"images": ["21", 0], "fps": ["7", 2], "audio": ["7", 1]}}
    g["23"] = {"class_type": "SaveVideo",
               "inputs": {"video": ["22", 0], "filename_prefix": filename_prefix,
                          "format": "auto", "codec": "auto"}}
    return g


def facefix_graph(k2, video, *, seed=0, detector="bbox/face_yolov8m.pt",
                  denoise=0.4, steps=None, cfg=None, guide_size=512, max_size=1024,
                  bbox_threshold=0.5, bbox_dilation=10, bbox_crop_factor=3.0,
                  feather=5, prompt="", node_spec=None,
                  filename_prefix="neon/facefix"):
    """Per-frame face restore — Impact Pack's FaceDetailer over every frame.

    FaceDetailer is an INPAINT, not a filter: it detects a face, crops it,
    re-samples that crop through a real image model at `denoise`, and composites
    it back feathered. So it needs MODEL/CLIP/VAE and conditioning, and the
    model it runs is the studio's image model — Krea 2, which is what drew the
    character sheets this footage was conditioned on, so a restored face lands
    in the same family as the identity it is restoring.

    Krea 2 is a turbo checkpoint at cfg 1.0, so the negative is a
    ConditioningZeroOut of the positive rather than a second encode — the same
    shape krea2_graph uses and for the same reason.

    `denoise` is the whole control and 0.4 is deliberately below Impact's own
    0.5 default: this runs on a face that already carries the character's
    identity, and the failure mode is not softness, it is a face that stops
    being the same person. Raise it only on a shot where the face is genuinely
    broken.

    EXPENSIVE, and it is worth being concrete about why: the sampler runs once
    per DETECTED FACE per FRAME, so a two-hander at 24fps is ~48 diffusion
    passes per second of footage. It is a hero-shot tool.

    No SAM. `sam_model_opt` is optional and only refines the mask edge, which
    `feather` already softens — and it is the input that would drag the
    `git+.../sam2` requirement into the venv the pinned install exists to
    protect.
    """
    steps = int(steps or k2.get("steps", 8))
    cfg = float(cfg if cfg is not None else k2.get("cfg", 1.0))
    g = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": k2["unet"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": k2["text_encoder"], "type": "krea2",
                         "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": k2["vae"]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}},
        "6": {"class_type": "UltralyticsDetectorProvider",
              "inputs": {"model_name": detector}},
        "7": {"class_type": "LoadVideo", "inputs": {"file": video}},
        "8": {"class_type": "GetVideoComponents", "inputs": {"video": ["7", 0]}},
        "9": {"class_type": "FaceDetailer", "inputs": _fit_node_inputs({
            "image": ["8", 0], "model": ["1", 0], "clip": ["2", 0], "vae": ["3", 0],
            "positive": ["4", 0], "negative": ["5", 0],
            "bbox_detector": ["6", 0],
            "guide_size": float(guide_size), "guide_size_for": True,
            "max_size": float(max_size), "seed": int(seed), "steps": steps,
            "cfg": cfg, "sampler_name": k2.get("sampler", "euler"),
            "scheduler": k2.get("scheduler", "simple"),
            "denoise": float(denoise), "feather": int(feather),
            "noise_mask": True, "force_inpaint": True,
            "bbox_threshold": float(bbox_threshold),
            "bbox_dilation": int(bbox_dilation),
            "bbox_crop_factor": float(bbox_crop_factor),
            # SAM inputs are required widgets even with no SAM model wired;
            # they are inert on the bbox-only path.
            "sam_detection_hint": "center-1", "sam_dilation": 0,
            "sam_threshold": 0.93, "sam_bbox_expansion": 0,
            "sam_mask_hint_threshold": 0.7, "sam_mask_hint_use_negative": "False",
            "drop_size": 10, "wildcard": "", "cycle": 1,
        }, node_spec)},
        # FaceDetailer's slot 0 is the composited result; the others are crops,
        # masks and the pipe.
        "10": {"class_type": "CreateVideo",
               "inputs": {"images": ["9", 0], "fps": ["8", 2], "audio": ["8", 1]}},
        "11": {"class_type": "SaveVideo",
               "inputs": {"video": ["10", 0], "filename_prefix": filename_prefix,
                          "format": "auto", "codec": "auto"}},
    }
    return g


# ------------------------------------------------------- H3 FACE REFINE ----
# The SECOND face pass, and the opposite shape from the one above.
#
# `facefix_graph` is an image model inpainting each frame INDEPENDENTLY: no
# tracking, no smoothing, no shared sampling, and every frame's face decided
# from scratch by a checkpoint that did not render the footage. That is the
# per-frame-detailer shimmer, and it costs ~7s per frame.
#
# This is Carasibana/ComfyUI-H3-FaceRefine (MIT): detect the face on every
# frame, smooth the trajectory, crop so the head FILLS a canvas, inject those
# real frames into H3's joint AV latent and re-sample the whole sequence in ONE
# pass, then warp back and composite. Temporal coherence is structural rather
# than hoped for, and it is H3 refining H3.
#
# The premise is a property of H3 rather than of resolution — the pack's own
# words, "H3 renders faces poorly when the head occupies a small fraction of
# the frame ... no post-process upscaler fixes it" — which is why a restore
# pass is not a substitute for this one.

#: Canvas presets. Cost scales with AREA, so 768 is 2.25x the latent tokens of
#: 512; `None` is the pack's `auto_capped_768`, which sizes the canvas from the
#: largest crop in the clip so no frame is ever downscaled, then caps it.
H3_FACE_CANVASES = {
    "auto": None,
    "512": 512,
    "768": 768,
    "1024": 1024,
}
#: MEASURED (2026-09-05, one 48-frame 1280x736 anime clip, faces ~14% of frame
#: height): `auto` is the WRONG default for the case this pass exists for.
#: `auto_capped_768` sizes the canvas from the largest crop and floors at 512,
#: so on the small faces this pass targets it chose 512x512 (2.5x
#: magnification) — below H3's native short edge — and came back visibly
#: softer than the same clip at 768 (3.8x) or 1024 (5.1x). 768 is H3's own
#: native short edge and was the best cost/quality point of the three: 97s
#: warm against 1024's 167s, and clearly sharper than 512 by eye. `auto` is
#: kept for footage whose faces are already large, where it avoids magnifying
#: past what the crop has detail for.
H3_FACE_CANVAS_DEFAULT = "768"

#: The pack's own enum, VERBATIM — `"auto (pyscenedetect)"`, spaces and
#: parentheses included. A combo value it does not declare is a validation
#: failure at submit, which on this path is minutes into a job.
H3_FACE_CUT_MODES = {"none": "none", "auto": "auto (pyscenedetect)"}

#: Steps and denoise, and BOTH are the plain-H3 numbers rather than the
#: template's. The pack ships 8 steps at denoise 0.4 on `er_sde` over an
#: 8-step fl2v turbo LoRA — a file this studio does not have (our `plain`
#: distillation is lightx2v's 4-step, a different adapter with a different
#: schedule), and substituting one distillation's steps for another's is the
#: silent downgrade `seedvr2_model` refuses one section up. So: the full
#: schedule at the same denoise. 20 steps at denoise 0.4 is ~20 real sampling
#: steps (BasicScheduler samples the last `steps` of a `steps/denoise`
#: schedule), against the template's 8.
H3_FACE_STEPS = 20
H3_FACE_DENOISE = 0.4


def h3_facefix_graph(h3, video, *, seed=0, denoise=H3_FACE_DENOISE,
                     steps=H3_FACE_STEPS, detector="bbox/face_yolov8m.pt",
                     confidence=0.35, crop_factor=3.0, canvas=None,
                     select="largest_face", identity_model="insightface",
                     smooth_window=21, size_smooth_window=51,
                     cut_detection="none", cut_threshold=3.0,
                     paste_region="face_only", mask_dilation=24, feather=24,
                     colour_match=1.0, blend=1.0,
                     denoise_small=1.0, denoise_large=0.35,
                     has_audio=True, prompt="", loras=None,
                     track_spec=None, stitch_spec=None, ref_spec=None,
                     denoise_spec=None, filename_prefix="qamba/h3facefix"):
    """Track a face, refine the crop sequence through H3, composite it back.

    Adapted from the pack's own `H3_Face_Refine_Auto_Select` template, with
    four deliberate differences — each of which is a fact about this pod
    rather than a preference:

    THE VIDEO IS LOADED WITH CORE'S `LoadVideo`, not VideoHelperSuite's
    uploader. The pack's own README says the VHS loader tints the result red;
    `facefix_graph` above already loads this way, so both face passes read
    their footage identically.

    THE AUDIO LOCK IS OURS. The template wires `MiniMaxH3NativeAudioLock` from
    a repo that ships no licence at all, and we already vendor
    `VRGDG_MiniMaxH3AudioDrive`, which writes the encoded source audio over
    the AV latent's audio half and zeroes the audio side of the noise mask.
    That mask is the entire contract `H3PerFrameDenoise` reads — its own
    comment is "keep the audio side exactly as NativeAudioLock left it", and
    it rebuilds the video half from a NestedTensor it unbinds. The one thing
    the other node additionally does is set
    `transformer_options["minimax_h3_lock_audio_clean"]`, and that flag is
    read by NOTHING: it appears exactly once in its own repository, core does
    not know the name, and this pack never mentions it. So the substitution is
    exact, and a silent-downgrade check was what established that rather than
    a reading of the two docstrings.

    NO IMAGE REFERENCES. The template stages two `LoadImage` identity refs; a
    post pass has no bible to draw them from, and `ref_images` is OPTIONAL on
    `MiniMaxH3ReferenceToVideo` (checked against a real engine's own
    `/object_info`, not assumed). The identity that matters here arrives as
    the injected latent — these ARE the frames, at low denoise.

    fl2va, NOT ref2va, which the template also does and which looks wrong next
    to a node called ReferenceToVideo. With no image references staged,
    ref2va's reference-processing blocks have nothing to process; the r2v node
    is being used for the AV latent and the audio ref, and fl2va is the
    general checkpoint.

    THE REFINED AUDIO IS DISCARDED — `CreateVideo` takes the source's own
    track, the same rule `apply_ltx_refine` follows. H3 is asked to attend to
    the audio so the mouth matches it, not to re-render it.

    `H3PerFrameDenoise` IS NOT OPTIONAL even at a uniform strength. It patches
    the MODEL to withhold the video mask from H3's per-token timesteps, and
    its own docstring says why: a mask otherwise reaches the result twice, and
    the disagreement "prints as a repeating grid at latent-cell size, for a
    uniform mask as much as a varying one". Its returned model must reach the
    guider AND the scheduler — the same pairing `_splice_h3_refine` is careful
    about.

    Frame count and the 17n+5 grid are the PACK's business, not this
    builder's: the tracker emits `frame_count` straight into the H3 node's
    `length`, H3 rounds up to its own grid, and `H3InjectVideoLatent` pads the
    difference. Invariant #5 holds without this file asserting it.
    """
    modes = h3.get("modes") or {}
    ckpt = ((modes.get("i2v") or {}).get("checkpoint")
            or h3.get("checkpoint"))
    if not ckpt:
        raise ValueError("no fl2va checkpoint declared for the H3 face refine")
    enc = (h3.get("text_encoders") or [h3.get("text_encoder")])[0]
    if not enc:
        raise ValueError("no text encoder declared for the H3 face refine")

    cw = int(canvas or 768)
    g = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": ckpt, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": enc, "type": "minimax", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": h3["vae"]}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": h3["audio_vae"]}},
        "5": {"class_type": "LoadVideo", "inputs": {"file": video}},
        "6": {"class_type": "GetVideoComponents", "inputs": {"video": ["5", 0]}},
        "7": {"class_type": "H3FaceTrackCrop", "inputs": _fit_node_inputs({
            "images": ["6", 0], "detector": detector,
            "confidence": float(confidence), "crop_factor": float(crop_factor),
            "canvas_width": cw, "canvas_height": cw,
            "canvas_mode": "manual" if canvas else "auto_capped_768",
            "smooth_window": int(smooth_window),
            "size_smooth_window": int(size_smooth_window),
            "smooth_method": "gaussian", "size_mode": "per_frame",
            "select": select, "identity_model": identity_model,
            "identity_track": True,
            # SPLIT AT HARD CUTS, so the smoothing kernel, the dropout
            # interpolation and the composite fade each stay inside one shot.
            # A timeline clip is NOT reliably one shot — every `spliced` take
            # the assembly screen publishes is several — and the pack is blunt
            # about what `none` does there: continuity "runs straight through a
            # real cut onto whichever face is nearest the last position, which
            # may be anyone". It costs no second decode; scenedetect rides the
            # face pass that is already converting every frame.
            "cut_detection": H3_FACE_CUT_MODES.get(cut_detection, cut_detection),
            "cut_threshold": float(cut_threshold),
        }, track_spec)},
        "12": {"class_type": "KSamplerSelect",
               "inputs": {"sampler_name": h3.get("sampler") or "res_multistep"}},
        "14": {"class_type": "RandomNoise", "inputs": {"noise_seed": int(seed)}},
    }
    model_out = _lora_chain(g, ["1", 0],
                            _norm_loras(list(loras or []),
                                        default_strength=h3.get("lora_strength", 1.0)))

    # The AV latent the crops are injected into. The clip's own soundtrack is
    # the one reference staged: it is what the mouth has to match.
    ref = {"clip": ["2", 0], "vae": ["3", 0], "audio_vae": ["4", 0],
           "prompt": prompt,
           "width": ["7", 4], "height": ["7", 5], "length": ["7", 6],
           "ref_image_size": "match"}
    if has_audio:
        ref[_autogrow_key(ref_spec, "ref_audios", 0, "ref_audio_")] = ["6", 1]
    g["8"] = {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": ref}
    g["9"] = {"class_type": "H3InjectVideoLatent",
              "inputs": {"av_latent": ["8", 1], "images": ["7", 0],
                         "vae": ["3", 0]}}
    latent = ["9", 0]
    if has_audio:
        # A SILENT clip skips this, and nothing downstream needs telling:
        # H3PerFrameDenoise falls back to `zeros_like` for the audio half when
        # the latent carries no mask yet, which is the same result.
        g["10"] = {"class_type": "VRGDG_MiniMaxH3AudioDrive",
                   "inputs": {"av_latent": latent, "source_audio": ["6", 1],
                              "audio_vae": ["4", 0]}}
        latent = ["10", 0]
    g["11"] = {"class_type": "H3PerFrameDenoise", "inputs": _fit_node_inputs({
        "model": model_out, "av_latent": latent, "transform": ["7", 1],
        "denoise_multiplier_small_face": float(denoise_small),
        "denoise_multiplier_large_face": float(denoise_large),
        "scale_mode": "absolute_px", "face_px_small": 30.0,
        "face_px_large": 120.0, "gamma": 1.0, "smooth_frames": 9,
    }, denoise_spec)}
    patched = ["11", 2]
    g["13"] = {"class_type": "BasicScheduler",
               "inputs": {"model": patched,
                          "scheduler": h3.get("scheduler") or "simple",
                          "steps": int(steps), "denoise": float(denoise)}}
    g["15"] = {"class_type": "BasicGuider",
               "inputs": {"model": patched, "conditioning": ["8", 0]}}
    g["16"] = {"class_type": "SamplerCustomAdvanced",
               "inputs": {"noise": ["14", 0], "guider": ["15", 0],
                          "sampler": ["12", 0], "sigmas": ["13", 0],
                          "latent_image": ["11", 0]}}
    g["17"] = {"class_type": "VAEDecode",
               "inputs": {"samples": ["16", 0], "vae": ["3", 0]}}
    g["18"] = {"class_type": "H3FaceStitch", "inputs": _fit_node_inputs({
        "base_images": ["6", 0], "refined_crops": ["17", 0],
        "transform": ["7", 1], "paste_region": paste_region,
        "mask_dilation": int(mask_dilation), "feather": int(feather),
        "colour_match": float(colour_match), "blend": float(blend),
        "undetected_frames": "fade_out",
    }, stitch_spec)}
    g["19"] = {"class_type": "CreateVideo",
               "inputs": {"images": ["18", 0], "fps": ["6", 2], "audio": ["6", 1]}}
    g["20"] = {"class_type": "SaveVideo",
               "inputs": {"video": ["19", 0], "filename_prefix": filename_prefix,
                          "format": "auto", "codec": "auto"}}
    return g


def krea2_identity_graph(k2, prompt, seed, width, height, *, subject, scene=None,
                         identity_lora, ref_boost=3.0, scene_boost=1.0,
                         grounding_px=768, steps=None, cfg=None, loras=None,
                         patch_spec=None, enc_spec=None):
    """Krea 2 IDENTITY EDIT, the way the adapter was trained — the API form of
    lbouaraba's `krea2_identity_edit.json` and of The AI Brief's Multi-Shot
    Stills pass (Short Film Director Pipeline: character sheet -> N panels).

    `krea2_ref_graph` conditions on references through Krea2EditRebalance,
    which describes them into the Qwen3-VL stream and touches no latent. The
    Identity Edit LoRA was not trained against that: its trainer prepends the
    source image's VAE latent as CLEAN IN-CONTEXT TOKENS at RoPE frame 1 and
    grounds the text encoder on the same image, and applying the LoRA without
    both is what "normalized the wardrobe" and duplicated torsos in the
    measurements that kept it off base sheets. Both halves are here:

      LoadImage(subject) -> VAEEncode -> Krea2EditModelPatch.source_latent
                         -> Krea2EditGroundedEncode.image   (+ the prompt)
      UNETLoader -> LoraLoaderModelOnly(identity @1.0) -> [picks] -> Patch.model
      Patch -> KSampler.model ; GroundedEncode -> KSampler.positive

    `scene` is the optional SECOND reference (a location plate): the pack's
    trained order is scene on the main inputs, subject on the `_b` inputs,
    with `ref_boost` the subject's fidelity dial and `scene_boost` the
    scene's. With no scene the subject IS the main source — the single-source
    shape the pack ships and the one measured on the reference board, where
    16 panels held one face and one outfit from one sheet at ref_boost 4.

    The negative is the trained unconditional — a grounded encode of an EMPTY
    prompt on the same image — which the README asks for at cfg > 1; at the
    turbo recipe's cfg 1.0 it is never evaluated, so it costs nothing.

    `target_latent` is wired to the SAME empty latent the sampler reads, per
    the pack's own VRAM note: without it the source is VAE-encoded on the
    first sampling step, which can evict part of the diffusion model.
    """
    steps = int(steps or k2.get("steps", 8))
    cfg = float(cfg if cfg is not None else k2.get("cfg", 1.0))
    stack = [(identity_lora, 1.0)] + [p for p in _norm_loras(loras, None, None, k2.get("lora_strength", 1.0))
                                      if p[0] != identity_lora]
    g = {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": k2["unet"], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": k2["text_encoder"], "type": "krea2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": k2["vae"]}},
        "6": {"class_type": "EmptySD3LatentImage",
              "inputs": {"width": int(width), "height": int(height), "batch_size": 1}},
        "20": {"class_type": "LoadImage", "inputs": {"image": subject, "upload": "image"}},
        "21": {"class_type": "VAEEncode", "inputs": {"pixels": ["20", 0], "vae": ["3", 0]}},
    }
    model_out = _lora_chain(g, ["1", 0], stack)
    # Main source / second reference, in the pack's trained order.
    if scene:
        g["22"] = {"class_type": "LoadImage", "inputs": {"image": scene, "upload": "image"}}
        g["23"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["22", 0], "vae": ["3", 0]}}
        main_img, main_lat, b_img, b_lat = ["22", 0], ["23", 0], ["20", 0], ["21", 0]
    else:
        main_img, main_lat, b_img, b_lat = ["20", 0], ["21", 0], None, None
    patch = {"model": model_out, "source_latent": main_lat, "vae": ["3", 0],
             "source_image": main_img, "target_latent": ["6", 0],
             "fit_mode": "fit", "ref_boost": float(ref_boost),
             "ref_boost_a": float(scene_boost)}
    enc = {"clip": ["2", 0], "prompt": prompt, "image": main_img,
           "grounding_px": int(grounding_px)}
    neg = {"clip": ["2", 0], "prompt": "", "image": main_img,
           "grounding_px": int(grounding_px)}
    if b_img:
        patch.update({"source_latent_b": b_lat, "source_image_b": b_img})
        enc["image_b"] = b_img
        neg["image_b"] = b_img
    g["30"] = {"class_type": "Krea2EditModelPatch", "inputs": _fit_node_inputs(patch, patch_spec)}
    g["31"] = {"class_type": "Krea2EditGroundedEncode", "inputs": _fit_node_inputs(enc, enc_spec)}
    g["32"] = {"class_type": "Krea2EditGroundedEncode", "inputs": _fit_node_inputs(neg, enc_spec)}
    g["7"] = {"class_type": "KSampler",
              "inputs": {"model": ["30", 0], "seed": int(seed), "steps": steps, "cfg": cfg,
                         "sampler_name": k2.get("sampler", "euler"),
                         "scheduler": k2.get("scheduler", "simple"),
                         "positive": ["31", 0], "negative": ["32", 0],
                         "latent_image": ["6", 0], "denoise": 1.0}}
    g["8"] = {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}}
    g["9"] = {"class_type": "SaveImage",
              "inputs": {"images": ["8", 0], "filename_prefix": "qamba/krea2id"}}
    return g

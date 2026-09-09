"""v2 image generation: bible ref sheets, scene stills, free-form images.

Reuses the v1 graph builders (klein multi-ref / krea2 / flux2 / flux kontext)
with gpt-image-1.5 as the no-local-model fallback, but registers results as v2
assets and can auto-attach them to a bible entry slot or scene still — that's
what lets a tier-1 one-shot run build its own character sheets unattended.
"""
import os
import time

import comfy
import genmedia
import graphs
import gridsheet
import image_prompt
import media
import resolve as R
import resolve_custom as RC
import sb
from handlers.common import COMFY_ROOT, make_tick, _load_map_tier
from status import log


def _slice_grid_panels(png, grid_asset, grid, jid, project_id):
    """Cut a rendered storyboard grid into per-beat panel assets.

    NOT REACHED BY THE PIPELINE any more — panels are one render per beat
    (`llm.py`, `prompt_spec.kind == "panel"`) because the grid produced nine
    malformed images out of ten. This survives only for a hand-built payload
    carrying `grid`, so grids can be retried against a future model without
    rebuilding the slicer; `verify_grid` below means such a retry cannot ship
    garbage panels the way the original did.

    `grid` = {rows, cols, beat_ids (ordered, panel k <- beat_ids[k-1]),
    scene_id}. Boxes come from the image's ACTUAL size — families snap
    requested dims, and slicing the requested geometry off a snapped render
    shears every panel.
    """
    from PIL import Image
    rows, cols = int(grid.get("rows") or 1), int(grid.get("cols") or 1)
    beat_ids = list(grid.get("beat_ids") or [])
    with Image.open(png) as im:
        # Prove the model drew the grid before cutting it up. A requested 2x3
        # came back as one row of three portraits (THE-LOOP, live), and the
        # slicer happily produced "panels" that were the bottom halves of
        # other panels — then staged them into the render as storyboard
        # references. A missing panel is recoverable; a confidently wrong one
        # is not, so a failed grid attaches nothing.
        if rows * cols > 1:
            g = im.convert("L")
            ok, why = gridsheet.verify_grid(list(g.getdata()), g.width, g.height,
                                            rows, cols)
            if not ok:
                log(f"grid REJECTED for {jid}: {why} — no panels attached")
                return
        boxes = gridsheet.slice_boxes(im.width, im.height, rows, cols,
                                      len(beat_ids))
        made = 0
        for k, (bid, (x, y, w, h)) in enumerate(zip(beat_ids, boxes), start=1):
            part = f"/tmp/{jid}_p{k}.png"
            im.crop((x, y, x + w, y + h)).save(part)
            pkey = f"stills/panels/{bid}/{jid}_p{k}.png"
            media.b2_put(part, pkey, content_type="image/png")
            passet = sb.register_asset(
                pkey, "image", project_id=project_id,
                content_type="image/png", source_job_id=jid,
                width=w, height=h,
                meta={"grid_asset_id": grid_asset["id"], "panel_idx": k,
                      "beat_id": bid, "scene_id": grid.get("scene_id")},
                tags=["storyboard-panel"])
            rows_ = sb.get(f"beats?id=eq.{bid}&select=id,meta")
            if rows_:
                # Through the same rule as every other panel write, so a
                # re-slice keeps the panel it replaces (`beat_meta_after`).
                bmeta = beat_meta_after(rows_[0].get("meta"), passet["id"],
                                        "panel")
                sb.patch(f"beats?id=eq.{bid}", {"meta": bmeta})
            try:
                os.remove(part)
            except OSError:
                pass
            made += 1
    if grid.get("scene_id"):
        srows = sb.get(f"scenes?id=eq.{grid['scene_id']}&select=id,meta")
        if srows:
            smeta = srows[0].get("meta") or {}
            smeta["grid_asset_id"] = grid_asset["id"]
            sb.patch(f"scenes?id=eq.{grid['scene_id']}", {"meta": smeta})
    log(f"storyboard grid sliced: {made} panel(s) attached to beats")


def resolve_kind(kind):
    return {"image_gen": handle_image_gen,
            "sheet_compose": handle_sheet_compose}[kind]


# Superseded sheets are archived here rather than deleted (the regen_sheets.py
# convention), so every consumer resolves a role with `order=slot&limit=1` and
# the new plate wins the moment it lands. That ordering is NOT enough on its
# own: a role whose only rows are archived still returns one, so an entry whose
# last good sheet was archived quietly restages the picture that was replaced.
# Measured — a deformed face plate was archived along with everything derived
# from it, and panels went on anchoring the deformed turnaround because it was
# the sole row of its role. blocks.py's ref plan has always filtered; this did
# not.
ARCHIVE_SLOT = 90


def _resolve_anchor(payload, taken=None):
    """Late-bound identity anchor.

    `taken`, when a list is passed, collects `{entry_id, role}` for each asset
    resolved, parallel to the returned ids. It exists because a `roles` list is
    a PREFERENCE order — a panel asking a location for its reverse angle gets
    the master when no reverse angle is on file — and the prompt describes what
    was staged. Composing from the request rather than the result is how a
    prompt comes to name a picture the graph was never handed.

    A body/outfit sheet queued before its face sheet exists cannot name the
    asset id — the face has not been rendered yet. It names the entry and role
    instead, and we look it up here, after the dependency has completed.

    `anchor_roles` takes several slots in order (e.g. ["full_body","face"]):
    the FIRST is the edit source, the rest condition. Outfit variants need
    both — editing the body sheet alone gave identity models a face a few
    dozen pixels wide, which is how a variant came back as a different person.
    """
    # Two shapes: the single-entry form (anchor_entry_id + anchor_roles), and
    # `anchors` = [{entry_id, roles}] for jobs anchored on SEVERAL entries —
    # a scene grid conditions on each cast member's face plus the location's
    # master, and no single entry can name that set.
    specs = payload.get("anchors")
    if not isinstance(specs, list):
        eid = payload.get("anchor_entry_id")
        if not eid:
            return []
        specs = [{"entry_id": eid,
                  "roles": (payload.get("anchor_roles")
                            or [payload.get("anchor_role") or "face"])}]
    out = []
    for spec in specs:
        eid = (spec or {}).get("entry_id")
        if not eid:
            continue
        found = False
        # `first`: take the BEST available slot, not every listed one. The
        # default appends each role it finds, which is right for an outfit
        # variant's edit (source + conditioning) and wrong for a panel, where a
        # preference order like turnaround > full_body > face would stage three
        # pictures of one person and crowd everyone else out of the slot budget.
        one = bool(spec.get("first"))
        for role in (spec.get("roles") or ["face"]):
            rows = sb.get(f"bible_assets?entry_id=eq.{eid}&role=eq.{role}"
                          f"&slot=lt.{ARCHIVE_SLOT}"
                          f"&order=slot&limit=1&select=asset_id")
            if rows:
                found = True
                if rows[0]["asset_id"] not in out:
                    out.append(rows[0]["asset_id"])
                    if taken is not None:
                        taken.append({"entry_id": eid, "role": role})
                if one:
                    break
        if not found:   # fall back to any ref for the entry rather than none
            # …except a CONTACT SHEET. `coverage` is a grid of eight views of
            # one place, and every caller of this function is composing a
            # single still — so staging it here hands a panel a picture of a
            # grid, which the image families reproduce (that is the whole
            # finding behind `scene_grids` being off). "Anything rather than
            # nothing" is right for a plate and wrong for a sheet: composing
            # the location from its prose is the better failure.
            rows = sb.get(f"bible_assets?entry_id=eq.{eid}"
                          f"&role=neq.coverage"
                          f"&slot=lt.{ARCHIVE_SLOT}"
                          f"&order=slot&limit=1&select=asset_id,role")
            for r in rows:
                found = True
                if r["asset_id"] not in out:
                    out.append(r["asset_id"])
                    if taken is not None:
                        taken.append({"entry_id": eid, "role": r.get("role")})
        if not found:
            # A variant with no sheet of its own is anchored by its PARENT —
            # the same doc.variant_of walk blocks.py's ref plan already does.
            # A variant's sheets are derived jobs (an identity edit of the
            # parent's body), so there is an honest window in which the entry
            # exists and its pictures do not; staging the parent there keeps
            # identity in the frame while the wardrobe rides the prose.
            # Measured before this existed: a panel whose variant had no sheet
            # staged NOTHING for that character, and she was drawn from her
            # sentence alone. (A DANGLING entry id — a discarded draft a
            # queued job still anchors — has no row to walk and resolves to
            # nothing; the compose-time prune is what keeps the envelope
            # honest there.)
            erows = sb.get(f"bible_entries?id=eq.{eid}&select=doc")
            parent = ((erows[0].get("doc") or {}).get("variant_of")
                      if erows else None)
            if parent:
                for role in ("turnaround", "full_body", "outfit", "face"):
                    rows = sb.get(f"bible_assets?entry_id=eq.{parent}&role=eq.{role}"
                                  f"&slot=lt.{ARCHIVE_SLOT}"
                                  f"&order=slot&limit=1&select=asset_id")
                    if rows:
                        log(f"anchor: variant {eid} has no sheet — staging its "
                            f"parent's {role}")
                        if rows[0]["asset_id"] not in out:
                            out.append(rows[0]["asset_id"])
                            if taken is not None:
                                taken.append({"entry_id": eid, "role": role})
                        break
    return out


_NODES = {}
_NODE_TTL = 300          # seconds before a *negative* answer is re-checked
_NODE_TTL_UNREACHABLE = 15   # ComfyUI did not answer at all: ask again shortly

# How many alternate takes of one shot a beat keeps (`target.as == "panel_alt"`).
# A scratch list a human picks from, so it is bounded and newest-wins: every
# re-roll would otherwise add to it forever, and the pictures themselves stay
# in the library regardless — dropping an id here loses the offer, not the file.
PANEL_ALTS_KEPT = 8


def beat_meta_after(meta, asset_id, as_):
    """The beat meta a landed picture produces. Pure, so the browser twin
    (`hostedRender.applyImageTarget`) and the tests can be checked against the
    real rule rather than against a copy of it.

    `as: "panel"` writes the AUTO slot, leaving `still_asset_id` for what a
    human deliberately designated — the ref plan ranks a user still above a
    generated panel, and it can only do that if the two live in different keys.

    `as: "panel_alt"` is a THIRD thing and writes neither: an alternate take of
    this shot, offered for a human to choose from. It has to be its own mode
    because the other two are single-slot and last-writer-wins — five
    alternates targeting `panel` would simply overwrite each other and leave
    one arbitrary survivor, which is the opposite of a choice. Nothing
    downstream reads `panel_alts`; promoting one into `panel_asset_id` is the
    deliberate act, and it happens in the browser.

    AND A REPLACED PANEL IS KEPT, which is the one rule that is not obvious.
    A single-roll redraw is the common way to fix a panel, and it OVERWRITES
    `panel_asset_id` — so the picture it replaces used to be dropped from the
    beat entirely, with nothing on the redraw screen able to reach it again.
    The rail beside the prompt read "0 alternates" no matter how many times you
    redrew, and going back to the take you preferred meant finding it in the
    library by eye. Both facts are already on file — the file is never deleted
    and the list is bounded — so keeping the id costs nothing and makes the
    rail the shot's roll history: one click promotes the previous take back,
    with no render. It is skipped when the panel is unchanged (a re-accept of
    the same asset) so a repeat cannot fill the list with one picture.
    """
    meta = dict(meta or {})
    alts = [a for a in (meta.get("panel_alts") or []) if isinstance(a, str)]
    if as_ == "panel_alt":
        if asset_id not in alts:
            alts.append(asset_id)
        # Bounded: this is a scratch list a human picks from, and an unbounded
        # one would grow every time someone re-rolls.
        meta["panel_alts"] = alts[-PANEL_ALTS_KEPT:]
        return meta
    if as_ == "panel":
        prev = meta.get("panel_asset_id")
        meta["panel_asset_id"] = asset_id
        if isinstance(prev, str) and prev and prev != asset_id:
            if prev not in alts:
                alts.append(prev)
            meta["panel_alts"] = alts[-PANEL_ALTS_KEPT:]
        return meta
    meta["still_asset_id"] = asset_id
    return meta


def _object_info(refresh=False):
    """ComfyUI's node schema, cached — it is a big response and rarely changes.

    Cached, but not forever, and that distinction matters: a node can appear
    under a long-lived worker (install it, restart ComfyUI) and the worker has
    no way to hear about it. A stale "absent" is silent and expensive — Krea 2
    reference jobs quietly rendered on Klein for as long as the process lived,
    logging a fallback that looked like a deliberate capability limit.

    "ComfyUI answered and the node is not there" and "ComfyUI did not answer"
    are cached for very different lengths, because only the first is an answer.
    systemd starts neon-worker and comfyui together and ComfyUI takes minutes
    longer, so the second is the NORMAL state for the first minutes of every
    boot — and caching it for the full TTL means whatever claims a job in that
    window renders degraded. Measured on this box 2026-08-14: three chained
    blocks fell back to the last-frame anchor at 10:15 because the
    motion-context pack read as absent, the cache expired at 10:40, and 10:47
    onwards chained normally. Same window, same silence, for Krea 2 references
    landing on Klein.
    """
    if refresh or "all" not in _NODES:
        try:
            _NODES["all"] = comfy.object_info() or {}
            _NODES["ttl"] = _NODE_TTL
        except Exception as e:                      # noqa: BLE001
            log(f"object_info unavailable ({e}) — assuming custom nodes absent")
            _NODES["all"] = {}
            _NODES["ttl"] = _NODE_TTL_UNREACHABLE
        _NODES["at"] = time.time()
    return _NODES["all"]


def _has_node(name):
    """Is a custom node installed?

    Only misses are re-checked, and only every _NODE_TTL: a hit cannot go stale
    in a way that hurts (a removed node fails loudly at submit), while a miss
    is exactly the answer that silently downgrades what we render.
    """
    if name in _object_info():
        return True
    if time.time() - _NODES.get("at", 0) < _NODES.get("ttl", _NODE_TTL):
        return False
    log(f"re-checking ComfyUI for '{name}' (cached answer was 'absent')")
    return name in _object_info(refresh=True)


def _node_spec(name):
    """The installed node's declared inputs, so a graph can be fitted to the
    version actually present rather than the one a workflow was authored on."""
    return _object_info().get(name)


def _family(imodels, key):
    """Which graph builder a model key runs on.

    Dispatch used to be `model == "krea2"`, so every Krea 2 checkpoint finetune
    would have fallen through to the hosted branch — an API call standing in
    for a 13GB local model, silently. The map
    entry declares its `family`; the key itself is only the fallback.
    """
    return (imodels.get(key) or {}).get("family") or key


def _hosted_row(model):
    """The catalog row when `model` names a HOSTED model, else None.

    `_family` falls back to the key itself for anything model_map does not
    declare, and the tail of handle_image_gen's dispatch chain was a hardcoded
    gpt-image-1.5 call — so every hosted pick rendered as gpt-image-1.5 at
    quality "medium", whatever the picker said. Measured: `gpt-image-2` and
    `gpt-image-1.5` are separate rows in the wizard's image-model picker and
    produced byte-identical routing; the Nano Banana rows would have joined
    them. Silent, and exactly the substitution `_family`'s own docstring is
    about one function up.

    Hosted rows are catalogued under the same id the browser sends as
    `model_key` (modelKeyOf only strips a `-local` suffix, which hosted rows
    do not carry), so the id IS the lookup.
    """
    row = (sb.model_catalog() or {}).get(model) or {}
    prov = row.get("provider")
    if not prov or prov == "local":
        return None
    from providers import PROVIDERS
    return row if prov in PROVIDERS else None


def _resolve_loras(payload, imodels, model):
    """Turn the payload's LoRA KEYS into filenames for this model.

    The browser never sees a .safetensors name (it ships keys from the catalog's
    capabilities.styleLoras; the map owns the files). Accepts the single-LoRA
    shape `lora` + `lora_strength` and the stack shape
    `loras: ["filmgrain", {"key":"lineart","strength":0.8}]`. A key this model does
    not declare is dropped with a log line rather than handed to ComfyUI, which
    would fail the whole job on a missing file.

    Returns (stack, triggers): [(filename, strength)…] and any trigger words the
    dropped-in LoRAs need in the prompt.
    """
    spec = imodels.get(model) or {}
    catalogued = spec.get("style_loras") or {}
    trigger_map = spec.get("lora_triggers") or {}
    default_strength = float(spec.get("lora_strength", 1.0) or 1.0)

    wanted = []
    for item in (payload.get("loras") or []):
        if isinstance(item, str):
            wanted.append((item, None))
        elif isinstance(item, dict):
            k = item.get("key") or item.get("lora") or item.get("name")
            if k:
                wanted.append((k, item.get("strength", item.get("weight"))))
    if payload.get("lora"):
        wanted.append((payload["lora"], payload.get("lora_strength")))

    stack, triggers, seen = [], [], set()
    for key, strength in wanted:
        if key in seen:
            continue
        seen.add(key)
        if key in catalogued:
            fn = catalogued[key]
            if trigger_map.get(key):
                triggers.append(trigger_map[key])
        elif isinstance(key, str) and key.endswith(".safetensors"):
            # escape hatch: a file dropped on the pod without a map entry
            fn = key
        else:
            log(f"image_gen: no LoRA '{key}' for {model} — skipping it")
            continue
        stack.append((fn, float(strength) if strength is not None else default_strength))
    return stack, triggers


def _h3_files(tier, spec):
    """Flatten the video-side H3 entry into what h3_image_graph wants.

    The image entry carries no filenames — it points at the video model, which
    is where H3's checkpoint/encoder/VAEs are already declared and fetched.
    """
    src = (tier.get("models") or {}).get(spec.get("from_model") or "minimax-h3") or {}
    modes = src.get("modes") or {}
    # Both checkpoints, because the mode decides which one is correct: ref2va
    # conditions on a reference set, fl2va on an opening frame or on nothing.
    ref_ckpt = (modes.get(spec.get("mode") or "r2v") or {}).get("checkpoint")
    frame_ckpt = (modes.get("i2v") or modes.get("t2v") or {}).get("checkpoint")
    out = {
        "ref_checkpoint": ref_ckpt,
        "frame_checkpoint": frame_ckpt,
        "checkpoint": ref_ckpt or frame_ckpt,
        "text_encoder": (src.get("text_encoders") or [None])[0],
        "vae": src.get("vae"),
        "audio_vae": src.get("audio_vae"),
    }
    # PDD is a property of the CHECKPOINTS, so it is inherited with them: the
    # acceleration files are trained against fl2va and ref2va and an image row
    # pointing at `minimax-h3-pdd` wants exactly the pair that entry declares.
    # An image row may still override (a still can afford a different nfe from
    # a fourteen-second block), which is why the image entry is consulted after.
    if src.get("pdd"):
        out["pdd"] = src["pdd"]
    # Everything below belongs to the IMAGE entry, not the video one it borrows
    # weights from: the single-frame decoder, the sampling recipe and the
    # per-checkpoint turbo adapters are all things that are only true of a still.
    for k in ("image_vae", "sampler", "scheduler", "steps",
              "frame_turbo", "ref_turbo", "turbo_strength", "lora_strength",
              "pdd"):
        if spec.get(k) is not None:
            out[k] = spec[k]
    return out


def _stage_refs(ids, jid):
    names, paths = [], []
    # 9 = the most any local image model takes (H3 ref2va). Each builder trims to
    # its own ceiling; staging fewer than that here would silently drop refs the
    # chosen model could have used.
    for i, aid in enumerate(ids[:9]):
        a = sb.asset_by_id(aid)
        if not a:
            continue
        ext = os.path.splitext(a["b2_key"])[1] or ".png"
        name = f"qamba_ig_{jid}_{i}{ext}"
        local = os.path.join(COMFY_ROOT, "input", name)
        media.b2_get(a["b2_key"], local)
        names.append(name)
        paths.append(local)
    return names, paths


def _control_kwargs(names, lora, payload):
    """Krea 2 depth-control arguments for krea2_ref_graph.

    `control_strength` is the dial between strict structural reproduction (1.0)
    and creative freedom. It matters more here than a strength usually does: a
    depth map carries the plate's CAMERA as well as its geometry, so at 1.0
    every panel of a location inherits the master's viewpoint — which is the
    opposite of coverage. Default below 1.0 for that reason.
    """
    return {
        "control_image": names[0],
        "control_lora": lora,
        "control_strength": float(payload.get("control_strength") or 0.7),
        "control_preprocess": payload.get("control_preprocess",
                                          "DepthAnythingV2Preprocessor"),
        "control_spec": _node_spec("Krea2ControlLoRALoader"),
        "control_enc_spec": _node_spec("Krea2ControlImageEncode"),
        "control_pre_spec": _node_spec("DepthAnythingV2Preprocessor"),
    }


def finalize_spec(spec, planned, anchor_roles, has_refs):
    """The prompt_spec as it should be COMPOSED, given what actually resolved.

    Extracted from `handle_image_gen` so a caller that composes EARLY — see
    llm.redraw_panels, which composes a hosted panel at queue time so the job
    can leave the pod's lane — applies the identical rules rather than a second
    reading of them. Pure: `anchor_roles` is what `_resolve_anchor` collected,
    `planned` is the payload's own `anchors` list, and nothing here reads the
    database.

    Every rule in it was a measured bug. Read the comments below rather than
    trusting the name.
    """
    # `from_ref` is decided HERE, for the same reason the prompt is composed
    # here: this is the first point at which it is a fact rather than an
    # intention. A caller can say it and be wrong (its anchor resolved to
    # nothing), or mean it and forget — llm.py set it on environment angles
    # only, so every ref-anchored CHARACTER sheet was composed as though it
    # were text-to-image, which is what rendered a "tight face portrait" of
    # a knight as the whole knight (see image_prompt.CHARACTER_MOVE).
    # `ref_ids` is the staged set after every fallback above, so it cannot
    # disagree with what the graph is given.
    if has_refs:
        spec = {**spec, "from_ref": True}
    # Same rule for the location PLATE, and the same reason. `roles` is a
    # preference order, so a panel that asked for the reverse angle gets the
    # master when the location has no reverse angle on file — and the
    # envelope would then tell the model it is looking at a picture nobody
    # staged. Correct it to what resolved; a caller supplying explicit
    # `ref_asset_ids` owns its own labels and is left alone.
    if spec.get("plate"):
        got = next((t["role"] for t in anchor_roles
                    if t["role"] in image_prompt.ENVIRONMENT_ROLES), None)
        if got and got != spec["plate"]:
            log(f"image_gen: location plate {spec['plate']} not on file — "
                f"composed against {got}")
            spec = {**spec, "plate": got}
    # The H3 envelope binds <Subject N> to <Picture N> BY POSITION in the
    # staged order, so the spec must describe what RESOLVED, not what was
    # planned. Measured on Rei E4: a draft-session discard deleted a
    # variant entry a queued panel still anchored, the anchor staged
    # nothing, and the envelope went on defining three subjects over two
    # pictures — "Guide Rei must match <Picture 2>" bound her to the
    # location plate and she rendered as a clone of Rei. Prune the subject
    # list (and its parallel labels) to the anchors that resolved: the
    # prose keeps the person, the binding stops lying. `cast_complete`
    # goes with the pruned subject — with someone unsheeted, "no other
    # people" would contradict the action naming them.
    if isinstance(planned, list) and isinstance(spec.get("ref_subjects"), list) \
            and len(spec["ref_subjects"]) == len(planned):
        resolved = {t.get("entry_id") for t in anchor_roles}
        keep = [i for i, a in enumerate(planned)
                if (a or {}).get("entry_id") in resolved]
        if len(keep) != len(planned):
            dropped = [str((spec["ref_subjects"][i] or {}).get("name"))
                       for i in range(len(planned)) if i not in keep]
            log(f"image_gen: {len(dropped)} planned reference(s) resolved "
                f"to no sheet ({', '.join(dropped)}) — envelope pruned to "
                f"the staged set")
            spec = {**spec,
                    "ref_subjects": [spec["ref_subjects"][i] for i in keep],
                    **({"refs": [spec["refs"][i] for i in keep]}
                       if isinstance(spec.get("refs"), list)
                       and len(spec["refs"]) == len(planned) else {})}
            spec.pop("cast_complete", None)
    return spec


def _identity_shape(payload, ref_ids):
    """Does this job stage ONE character sheet (+ optionally one plate)?

    Reads the composed spec's `ref_subjects` — the parallel labels
    `finalize_spec` prunes to the staged set — so the decision is about what
    the references ARE, not how many there are. True for a panel or still of
    one character with or without its location; false for two people, for a
    prop, and for a job with no spec at all (the composer's free references)."""
    spec = payload.get("prompt_spec")
    if not isinstance(spec, dict) or not ref_ids or len(ref_ids) > 2:
        return False
    subs = spec.get("ref_subjects")
    if not isinstance(subs, list) or len(subs) != len(ref_ids):
        return False
    kinds = [_subject_kind(x) for x in subs]
    if kinds[0] != "character":
        return False
    return all(k in ("character", "environment") for k in kinds) \
        and kinds.count("character") == 1


# `scene_panel_specs` labels a plate `location` (the bible's own kind) where
# `ref_plan` and the video compiler say `environment`. Measured on NIGHT
# SHIFT's first 28 panels (2026-09-02): every one carried `location`, so the
# identity path — written against the other spelling — never engaged once,
# and every panel rendered on the plain compose path with nothing to say a
# substitution had happened. Both spellings are one thing here.
_KIND_ALIASES = {"location": "environment", "env": "environment",
                 "cast": "character", "person": "character"}


def _subject_kind(sub):
    k = str((sub or {}).get("kind") or "").strip().lower()
    return _KIND_ALIASES.get(k, k)


def _identity_order(spec, ref_names):
    """(subject, scene) staged filenames for the identity graph: the one
    character is the subject, an environment reference the scene."""
    subs = (spec or {}).get("ref_subjects") or []
    subject = scene = None
    for i, name in enumerate(ref_names[:2]):
        kind = _subject_kind(subs[i] if i < len(subs) else None)
        if kind == "environment" and scene is None:
            scene = name
        elif subject is None:
            subject = name
    return subject or ref_names[0], scene


def handle_image_gen(job):
    jid = job["id"]
    payload = job.get("payload") or {}
    prompt = payload.get("prompt") or "reference image"
    width = int(payload.get("width") or 1024)
    height = int(payload.get("height") or 1024)
    seed = int(payload.get("seed") or 0)
    target = payload.get("target") or {}
    mode = (payload.get("mode") or "").lower()
    # An imported graph REPLACES the model rather than modifying it, so
    # everything below that reasons about a model_map entry — family dispatch,
    # the reference diversion, LoRAs, control — does not apply to it. Read here
    # so those decisions can say "not for a custom graph" instead of computing
    # an answer nobody will use and logging it as if it mattered.
    custom_id = payload.get("workflow_id")
    anchor_roles = []
    ref_ids = (list(payload.get("ref_asset_ids") or [])
               or _resolve_anchor(payload, anchor_roles))

    tier = _load_map_tier()
    imodels = tier.get("image_models") or {}
    model = payload.get("model_key")
    if not model:
        # Krea 2 is the quality default for fresh text-to-image (ref sheets).
        # Anything carrying identity refs goes to Qwen-Image-Edit 2509 first:
        # it is a model built for reference-driven editing, and its encode node
        # is core ComfyUI, so unlike Krea2EditRebalance it cannot be missing.
        # Klein — which held this slot — is a general image model that merely
        # accepts reference latents.
        if ref_ids:
            order = ("qwen-edit", "klein", "flux2", "krea2", "flux")
        else:
            order = ("krea2", "klein", "flux2", "flux")
        model = next((m for m in order if m in imodels), "gpt-image-1.5")
    wanted = model
    fam = _family(imodels, model)
    has_refs = bool(ref_ids)
    # An EDIT reworks the first reference; r2i composes a new frame out of the
    # set. The two are different graphs on every family that can do both, so the
    # mode has to travel — inferring "has references" cannot tell them apart,
    # and guessing wrong is what returns a different picture instead of an
    # edited one.
    editing = has_refs and (mode == "edit" or bool(payload.get("h3_edit")))
    # The Krea 2 family CAN take references — through the Krea2EditRebalance
    # custom node, on the same turbo checkpoint (this is the API-format form of
    # the Krea2 Multi-Reference workflow). Use it when the node is installed;
    # only fall back to Klein when it is not.
    krea2_refs = fam == "krea2" and has_refs and _has_node("Krea2EditRebalance")
    # The IDENTITY-EDIT path (graphs.krea2_identity_graph): the Identity Edit
    # LoRA applied the way it was trained — the character sheet as clean
    # in-context latent tokens plus an image-grounded encode — rather than as
    # a bare LoRA beside the Rebalance conditioning. It takes ONE subject and
    # at most one scene reference, which is exactly a storyboard panel of one
    # character (its turnaround, and the location plate as the scene): the
    # shape The AI Brief's reference board was measured holding one face and
    # one outfit across 16 panels. So it is chosen for a COMPOSITION on the
    # Krea 2 family with one or two references and a character in image1,
    # never for an EDIT (`mode: edit` reworks a picture, and the Rebalance
    # path seeds the sampler with it), never for a bare-`ref_asset_ids` job
    # from the composer (whose first reference is whatever the user dragged
    # in — not necessarily a person), and only where the pack is installed.
    # `payload.identity_edit` forces it either way.
    k2_id = (imodels.get(model) or {}).get("identity_edit") if fam == "krea2" else None
    id_files = (imodels.get(model) or {}).get("style_loras") or {}
    id_lora = id_files.get((k2_id or {}).get("lora") or "identity") if k2_id else None
    # OPT-IN ONLY since 2026-09-02, and that is a measurement rather than
    # caution. The first storyboard on which the shape test actually fired
    # (NIGHT SHIFT — `scene_panel_specs` labels the plate `location`, which
    # the test did not accept until the same day) was A/B'd on one panel,
    # same seed, same prompt: the compose path delivered the written medium
    # shot with the plate's own forecourt; identity WITH the plate as scene
    # latent came back a wide of the whole forecourt with the character tiny
    # (the in-context plate reproduces its own composition — "H3 obeys a
    # picture over a sentence", on Krea 2); identity SUBJECT-ONLY kept the
    # face, the outfit and the shot size and invented a different forecourt.
    # Neither arm is a storyboard panel a block can inherit, so the shape
    # test no longer routes on its own: `payload.identity_edit` asks for it,
    # and `_identity_shape` then only says whether the job CAN take it.
    krea2_identity = bool(
        krea2_refs and id_lora and not editing
        and _has_node("Krea2EditModelPatch") and _has_node("Krea2EditGroundedEncode")
        and payload.get("identity_edit")
        and (payload.get("identity_edit") == "force" or _identity_shape(payload, ref_ids)))
    # Flux.1's reference path is Kontext, and it is a ONE-image instruction
    # edit — the only local graph that starts from the source's own pixels.
    # Sending an edit to Klein instead (as this did whenever klein was mapped,
    # i.e. always) traded the one model trained for the job for one that
    # composes a fresh frame; the kontext branch below was unreachable.
    kontext = fam == "flux" and editing and bool((imodels.get(model) or {}).get("kontext"))
    # `anima` is in this list for the same reason `flux2` is: it is text-to-image
    # only. Anima's reference/edit adapters (ControlNet-LLLite, inpainting) are a
    # separate node stack we do not install, so a job carrying references must
    # move to a model that can actually read them rather than render a t2i over
    # them and look like the app ignored the input.
    # flux2 is NOT in this list any more. It reads references the Flux 2 way —
    # a ReferenceLatent per image chained onto both conditionings, the same
    # path Klein uses, since they are one architecture — and an entry declaring
    # `max_refs` is one whose builder wires them. It stayed here while the
    # builder's `refs` argument was missing, which is exactly the silent
    # failure the diversion existed to prevent.
    flux2_refs = fam == "flux2" and bool((imodels.get(model) or {}).get("max_refs"))
    if (not custom_id and fam in ("krea2", "flux", "flux2", "anima") and has_refs
            and not krea2_refs and not flux2_refs and not kontext):
        # What is left here has no reference path at all — plain Flux 2 in
        # particular has none, and it used to STAGE the references and render
        # without them, which is invisible from the outside. Identity anchors
        # matter more than the model preference, so the refs win — but say so,
        # because an explicit pick silently becoming another model is
        # indistinguishable from the app ignoring the setting.
        #
        # Qwen-Image-Edit 2509 is the target now, Klein only if it is absent:
        # Qwen is built for exactly this, and its encode node ships with
        # ComfyUI so the substitution can't itself fall through.
        sub = next((m for m in ("qwen-edit", "klein") if imodels.get(m)), None)
        if sub:
            model, fam = sub, _family(imodels, sub)
            if payload.get("model_key"):
                log(f"image_gen: {wanted} cannot take references — running {model} instead")

    # Compose here, not at enqueue time: the family is only final after the
    # reference fallback above may have swapped Krea 2 for Klein, and each
    # family reads a different prompt order (director/prompt_guides.js).
    spec = payload.get("prompt_spec")
    if isinstance(spec, dict) and spec:
        spec = finalize_spec(spec, payload.get("anchors"), anchor_roles, has_refs)
        # A HOSTED row composes for its PROVIDER, not for its catalog id —
        # see image_prompt.compose_family. `fam` itself is left alone: the
        # graph dispatch below is a chain of `fam == "..."` tests ending at
        # `_hosted_row(model)`, and moving it would be a second, invisible
        # change to which builder runs.
        prompt = image_prompt.compose(
            spec, image_prompt.compose_family(
                fam, (_hosted_row(model) or {}).get("provider")))
        log(f"image_gen: prompt composed for {fam} from spec ({spec.get('kind')}/"
            f"{spec.get('role')}{', from_ref' if has_refs else ''}"
            f"{', plate=' + spec['plate'] if spec.get('plate') else ''})")

    lora_stack, lora_triggers = _resolve_loras(payload, imodels, model)
    # Concept LoRAs are trained against a trigger word; without it the adapter
    # is loaded and does nothing, which reads as "the LoRA doesn't work".
    for t in lora_triggers:
        if t.lower() not in prompt.lower():
            prompt = f"{t}, {prompt}"

    ref_names, ref_paths = _stage_refs(ref_ids, jid)
    hosted_cost = 0.0          # set by the hosted branch; booked after the render
    hosted_meta = {}           # …and recorded on the asset, see register_asset
    editing = editing and bool(ref_names)
    # Structural control (Krea 2 only, today depth). The payload names an
    # ordinary registered asset — the location's master plate — and the graph
    # makes the control map from it, so nothing has to produce or store one.
    # Silently inert unless BOTH the pack and the adapter are present: this is
    # an enhancement to a render, never a reason to fail one.
    ctrl_names, _ = _stage_refs([payload["control_asset_id"]], f"{jid}c") \
        if payload.get("control_asset_id") else ([], [])
    ctrl_lora = (tier.get("image_control") or {}).get("krea2_depth")
    ctrl_ok = bool(ctrl_names and ctrl_lora and _has_node("Krea2ControlApply"))
    if ctrl_names and not ctrl_ok:
        log(f"image_gen: control plate ignored — lora={bool(ctrl_lora)} "
            f"node={_has_node('Krea2ControlApply')}")
    # How much of the source survives an edit. 1.0 is "keep nothing", which is
    # the composition path; the default holds the frame while leaving room for
    # the instruction.
    denoise = float(payload.get("denoise") or 0.55)
    denoise = min(1.0, max(0.05, denoise))
    png = f"/tmp/{jid}_img.png"
    tick = make_tick(job)
    try:
        loras_note = (" loras=" + ",".join(f"{n}@{s:g}" for n, s in lora_stack)) if lora_stack else ""
        if custom_id:
            # AN IMPORTED GRAPH IS DRIVEN BY ITS TAGGED SLOTS, never by matching
            # class_type — the same contract handle_clip_gen renders under, and
            # the reason `resolve_custom` exists. It is deliberately NOT folded
            # into the family chain below: a custom graph has no model_map
            # entry, so family, mode, denoise, control and the LoRA table are
            # all meaningless for it and every branch keyed off them would be a
            # lie about what is running.
            #
            # `resolve_custom` is kind-agnostic — its output list accepts an
            # image saver as readily as a video one — so nothing here is video
            # or image specific except which file we pull back and how it is
            # published.
            #
            # Everything the studio stages and this graph cannot read is
            # reported IGNORED rather than dropped in silence. References are
            # the sharp one: the image reference contract is a family-specific
            # wiring (Krea2EditRebalance, TextEncodeQwenImageEditPlus,
            # ReferenceLatent), and an imported graph declares its own inputs —
            # so a picked reference reaching a custom render would otherwise
            # vanish with the render still succeeding, which is exactly the
            # silent downgrade this file keeps naming. A tagged `start_frame`
            # slot IS honoured, and resolve_custom RAISES when one was staged
            # and no slot carries it.
            src = ref_names[0] if ref_names else None
            resolved = RC.resolve_for_job(
                custom_id, positive=prompt,
                negative=payload.get("negative") or None,
                seed=seed, width=width, height=height,
                source_image=src)
            wf = resolved["row"]
            extra = len(ref_names) - (1 if src and "start_frame" in resolved["wrote"] else 0)
            if extra > 0:
                log(f"image_gen custom: {extra} reference(s) ignored — image "
                    f"reference staging is family-specific and a custom graph "
                    f"declares its own inputs")
            if lora_stack:
                log(f"image_gen custom: {len(lora_stack)} LoRA pick(s) ignored — "
                    f"a custom graph carries its own adapters")
            if ctrl_names:
                log("image_gen custom: control plate ignored — a custom graph "
                    "declares its own control inputs")
            log(f"image_gen [custom] '{wf.get('name')}' {width}x{height} "
                f"wrote={','.join(resolved['wrote']) or 'nothing'} "
                f"outputs={','.join(resolved['outputs'])}: '{prompt[:60]}'")
            try:
                pid = comfy.submit(resolved["graph"])
                sb.job_patch(jid, {"comfy_prompt_id": pid})
                outs = comfy.wait(pid, on_tick=tick)
            except Exception as e:
                # ComfyUI's own refusal names the node and the class, which is
                # the most useful thing in the whole import flow — put it on
                # the workflow's card, not only in the job's error_msg.
                RC.record_failure(custom_id, e)
                raise
            comfy.fetch_output(outs, resolved["outputs"], png)
            RC.record_success(custom_id)
        elif fam == "h3" and imodels.get(model):
            spec = imodels[model]
            h3 = _h3_files(tier, spec)
            if not h3.get("checkpoint"):
                raise RuntimeError(f"{model}: no H3 checkpoint — is '{spec.get('from_model')}' in model_map?")
            # One reference is the published single-image edit; a set is the
            # reference composition. Both need ComfyUI's H3 nodes present.
            # fl2va's published single-image edit takes exactly one frame; two
            # or more references are a set, which is ref2va's job whatever the
            # mode says.
            edit_one = editing and len(ref_names) == 1
            w, h = graphs.h3_snap_dims(width, height)
            if (w, h) != (width, height):
                log(f"image_gen h3: snapped {width}x{height} -> {w}x{h} (H3 native size)")
            h3_refs = None if edit_one else (ref_names or None)
            h3_src = ref_names[0] if edit_one else None
            # The node decides the frame count and the frame count decides the
            # decoder, so probe the installed node rather than assuming the pod
            # carries the engine window's H3 single-frame patch. Say which way it went: a
            # five-frame render on the video VAE is the SOFT one, and "H3 stills
            # look blurry" with nothing in the log is how that stays a mystery.
            h3_node = graphs.h3_image_node(h3_refs, h3_src)
            h3_spec = _node_spec(h3_node)
            # The single-frame decoder is a 5.2GB file fetched by its OWN target
            # (the engine window's model list h3-image), while the node patch that makes one
            # frame legal rides in on any deploy — so a box can easily be
            # patched and not yet stocked. Declared-but-absent would then load
            # as a missing VAE and fail EVERY H3 image job, which is a far worse
            # outcome than the softness the file was there to fix.
            h3 = dict(h3)
            if h3.get("image_vae") and not os.path.exists(
                    os.path.join(COMFY_ROOT, "models", "vae", h3["image_vae"])):
                log(f"image_gen h3: {h3['image_vae']} not on this pod — "
                    f"staying on the video VAE (the engine window's model list h3-image)")
                h3.pop("image_vae")
            frames = graphs.h3_image_frames(h3_spec, h3)
            if frames > 1 and h3.get("image_vae"):
                log(f"image_gen h3: {h3_node} still declares length min>1 — "
                    f"rendering {frames} frames on the video VAE (softer). "
                    f"Run the engine window's H3 single-frame patch on the pod for the "
                    f"single-frame decoder.")
            pdd_note = (f" pdd={h3['pdd'].get('ref2va' if h3_refs else 'fl2va')}"
                        f"@{h3['pdd'].get('nfe', '8')}nfe" if h3.get("pdd") else "")
            log(f"image_gen h3: '{prompt[:60]}' {w}x{h} refs={len(ref_names)} "
                f"frames={frames}{loras_note}{pdd_note} "
                + ("single-image edit (fl2va)" if edit_one
                   else "reference set (ref2va)" if ref_names else "text-to-image (fl2va)"))
            pid = comfy.submit(graphs.h3_image_graph(
                h3, prompt, seed, width, height,
                refs=h3_refs, source_image=h3_src, loras=lora_stack,
                node_spec=h3_spec, steps=payload.get("steps"),
                pdd=h3.get("pdd")))
            sb.job_patch(jid, {"comfy_prompt_id": pid})
            outs = comfy.wait(pid, on_tick=tick)
            comfy.fetch_output(outs, list(outs.keys()), png)
            width, height = w, h
        elif fam == "sensenova" and imodels.get(model):
            sn = imodels[model]
            cap = int(sn.get("max_refs") or 10)
            if len(ref_names) > cap:
                log(f"image_gen sensenova: {len(ref_names)} refs staged but "
                    f"this entry takes {cap} — the last {len(ref_names) - cap} "
                    f"won't reach it")
            # TWO different nodes behind one family, and they size differently:
            # the reference path takes an explicit width/height, the t2i path
            # can only CHOOSE from eleven ~4MP options. Report the snap for the
            # same reason the O1 branch does — a 1280x704 ask coming back
            # 2720x1536 reads as a bug unless it is stated.
            if ref_names:
                gw, gh = int(width), int(height)
                how = f"{gw}x{gh} refs={min(len(ref_names), cap)}"
            else:
                gw, gh = graphs.sensenova_dims(width, height)
                how = f"{width}x{height} -> native {gw}x{gh} t2i"
            log(f"image_gen {model}: '{prompt[:60]}' {how} "
                f"{int(payload.get('steps') or sn.get('steps') or 50)}steps")
            pid = comfy.submit(graphs.sensenova_graph(
                sn, prompt, seed, gw, gh, refs=ref_names,
                steps=payload.get("steps"), cfg=payload.get("cfg"),
                img_cfg=payload.get("img_cfg"),
                cfg_norm=payload.get("cfg_norm"),
                timestep_shift=payload.get("timestep_shift"),
                think_mode=bool(payload.get("think_mode"))))
            sb.job_patch(jid, {"comfy_prompt_id": pid})
            outs = comfy.wait(pid, on_tick=tick)
            comfy.fetch_output(outs, list(outs.keys()), png)
            width, height = gw, gh
        elif fam == "hidream_o1" and imodels.get(model):
            hm = imodels[model]
            # O1 is trained at 2048-class resolutions and drifts off them, so
            # the graph snaps to the nearest trained shape of the SAME aspect
            # and the result is scaled back afterwards. Report both, or a
            # 1280x704 request silently producing a 2560x1440 file looks like a
            # bug rather than the design.
            gw, gh = graphs.hidream_o1_dims(width, height)
            log(f"image_gen {model}: '{prompt[:60]}' {width}x{height} "
                f"-> native {gw}x{gh} refs={min(len(ref_names), 10)}")
            pid = comfy.submit(graphs.hidream_o1_graph(
                hm, prompt, seed, width, height, refs=ref_names,
                steps=int(payload.get("steps") or hm.get("steps") or 40),
                cfg=payload.get("cfg"),
                node_spec=_node_spec("HiDreamO1PatchSeamSmoothing")))
            sb.job_patch(jid, {"comfy_prompt_id": pid})
            outs = comfy.wait(pid, on_tick=tick)
            comfy.fetch_output(outs, list(outs.keys()), png)
            width, height = gw, gh
        elif fam == "qwen" and imodels.get(model):
            qe = imodels[model]
            neg_ref_names, _ = _stage_refs(
                list(payload.get("negative_ref_asset_ids") or []), f"{jid}_neg")
            if neg_ref_names:
                log(f"image_gen qwen: {len(neg_ref_names)} NEGATIVE reference(s) "
                    f"— composing away from them")
            if len(ref_names) > 3:
                log(f"image_gen qwen: {len(ref_names)} refs staged but "
                    f"TextEncodeQwenImageEditPlus takes 3 — the last "
                    f"{len(ref_names) - 3} won't reach it")
            log(f"image_gen {model}: '{prompt[:60]}' {width}x{height} "
                f"refs={min(len(ref_names), 3)}{loras_note}")
            pid = comfy.submit(graphs.qwen_edit_graph(
                qe, prompt, seed, width, height, refs=ref_names,
                steps=int(payload.get("steps") or qe.get("steps") or 20),
                loras=lora_stack,
                # A picture to compose AWAY from. Staged like any other
                # reference (downloaded to ComfyUI's input dir) but wired to
                # the negative encoder only — see qwen_edit_graph. Qwen-only:
                # every other family either has no negative branch or runs it
                # at cfg 1, where it cannot contribute. The `_neg` suffix is
                # not cosmetic: _stage_refs names files `qamba_ig_<jid>_<i>`,
                # so staging a second set under the same jid would overwrite
                # the positive references on disk.
                negative_refs=neg_ref_names,
                node_spec=_node_spec("TextEncodeQwenImageEditPlus")))
            sb.job_patch(jid, {"comfy_prompt_id": pid})
            outs = comfy.wait(pid, on_tick=tick)
            comfy.fetch_output(outs, list(outs.keys()), png)
        elif fam == "klein" and imodels.get(model):
            km = imodels[model]
            # `payload.steps`/`payload.cfg` win, as they do on every other
            # family — this branch used to read model_map only, so a caller
            # could not try a different guidance without editing the deployed
            # map and there was no way to A/B a suspected mis-tune.
            k_steps = int(payload.get("steps") or km.get("steps") or 50)
            k_cfg = float(payload.get("cfg") or km.get("cfg") or 4.0)
            log(f"image_gen klein: '{prompt[:60]}' {width}x{height} "
                f"refs={len(ref_names)} {k_steps}steps/cfg{k_cfg:g}{loras_note}")
            pid = comfy.submit(graphs.flux2_klein_graph(
                km, prompt, seed, width, height, refs=ref_names,
                steps=k_steps, cfg=k_cfg, loras=lora_stack))
            sb.job_patch(jid, {"comfy_prompt_id": pid})
            outs = comfy.wait(pid, on_tick=tick)
            comfy.fetch_output(outs, list(outs.keys()), png)
        elif krea2_identity and imodels.get(model):
            k2 = imodels[model]
            subject, scene = _identity_order(payload.get("prompt_spec"), ref_names)
            # The instruction the grounded encoder reads WITH the picture in
            # view: the composed panel/still prompt, plus the identity lock
            # The AI Brief's board carried in every panel ("same character
            # from the reference sheet, exact face identity"). Stated as an
            # instruction, once, at the head — this encoder is an instruction
            # follower and the prompt is otherwise a shot description.
            id_prompt = ("Restage the person from the reference into this shot — "
                         "the same person, exact face identity, same hair and the "
                         "same outfit as the reference, one scene only, no split "
                         "screen and no reference-sheet layout. " + prompt)
            log(f"image_gen {model}+identity: '{prompt[:60]}' {width}x{height} "
                f"subject={subject}{' scene=' + scene if scene else ''} "
                f"ref_boost={float(payload.get('ref_boost') or k2_id.get('ref_boost', 3.0)):g}"
                f"{loras_note}")
            pid = comfy.submit(graphs.krea2_identity_graph(
                k2, id_prompt, seed, width, height, subject=subject, scene=scene,
                identity_lora=id_lora,
                ref_boost=float(payload.get("ref_boost") or k2_id.get("ref_boost", 3.0)),
                scene_boost=float(payload.get("scene_boost") or k2_id.get("scene_boost", 1.0)),
                grounding_px=int(payload.get("grounding_px") or k2_id.get("grounding_px", 768)),
                steps=k2.get("steps"), loras=lora_stack,
                patch_spec=_node_spec("Krea2EditModelPatch"),
                enc_spec=_node_spec("Krea2EditGroundedEncode")))
            sb.job_patch(jid, {"comfy_prompt_id": pid})
            outs = comfy.wait(pid, on_tick=tick)
            comfy.fetch_output(outs, list(outs.keys()), png)
        elif krea2_refs and imodels.get(model):
            k2 = imodels[model]
            # An edit seeds the sampler with the source and keeps its size; a
            # composition starts from an empty latent at the requested size.
            log(f"image_gen {model}+refs: '{prompt[:60]}' "
                + (f"edit of {ref_names[0]} @ denoise {denoise:g}" if editing
                   else f"{width}x{height} compose")
                + f" refs={len(ref_names)}{loras_note}")
            pid = comfy.submit(graphs.krea2_ref_graph(
                k2, prompt, seed, width, height, ref_names,
                steps=k2.get("steps"), loras=lora_stack,
                node_spec=_node_spec("Krea2EditRebalance"),
                source_image=ref_names[0] if editing else None,
                denoise=denoise if editing else 1.0,
                **(_control_kwargs(ctrl_names, ctrl_lora, payload) if ctrl_ok else {})))
            sb.job_patch(jid, {"comfy_prompt_id": pid})
            outs = comfy.wait(pid, on_tick=tick)
            comfy.fetch_output(outs, list(outs.keys()), png)
        elif fam == "krea2" and imodels.get(model):
            k2 = imodels[model]
            log(f"image_gen {model}: '{prompt[:60]}' {width}x{height}{loras_note}")
            pid = comfy.submit(graphs.krea2_graph(k2, prompt, seed, width, height,
                                                  loras=lora_stack))
            sb.job_patch(jid, {"comfy_prompt_id": pid})
            outs = comfy.wait(pid, on_tick=tick)
            comfy.fetch_output(outs, list(outs.keys()), png)
        elif fam == "anima" and imodels.get(model):
            am = imodels[model]
            log(f"image_gen {model}: '{prompt[:60]}' {width}x{height} "
                f"{am.get('steps', 30)}steps/cfg{am.get('cfg', 4.0):g}{loras_note}")
            pid = comfy.submit(graphs.anima_graph(
                am, prompt, seed, width, height,
                negative=payload.get("negative"),
                steps=int(payload.get("steps") or am.get("steps") or 30),
                loras=lora_stack))
            sb.job_patch(jid, {"comfy_prompt_id": pid})
            outs = comfy.wait(pid, on_tick=tick)
            comfy.fetch_output(outs, list(outs.keys()), png)
        elif fam == "flux2" and imodels.get(model):
            f2 = imodels[model]
            cap = int(f2.get("max_refs") or 0)
            if ref_names and len(ref_names) > cap and cap:
                log(f"image_gen flux2: {len(ref_names)} refs staged but this "
                    f"entry takes {cap} — the last {len(ref_names) - cap} won't reach it")
            log(f"image_gen {model}: '{prompt[:60]}' {width}x{height} "
                f"refs={min(len(ref_names), cap)}{loras_note}")
            pid = comfy.submit(graphs.flux2_ref_graph(
                f2, prompt, seed, width, height,
                steps=int(payload.get("steps") or f2.get("steps") or 20),
                refs=ref_names[:cap] if cap else None))
            sb.job_patch(jid, {"comfy_prompt_id": pid})
            outs = comfy.wait(pid, on_tick=tick)
            comfy.fetch_output(outs, list(outs.keys()), png)
        elif fam == "flux" and imodels.get(model):
            fm = imodels[model]
            if ref_names and fm.get("kontext"):
                graph = graphs.flux_kontext_graph(fm, prompt, ref_names[0], seed)
            else:
                graph = graphs.flux_ref_graph(fm, prompt, seed, width, height, loras=lora_stack)
            log(f"image_gen flux: '{prompt[:60]}'"
                + (f" kontext edit of {ref_names[0]}" if ref_names and fm.get("kontext") else "")
                + loras_note)
            pid = comfy.submit(graph)
            sb.job_patch(jid, {"comfy_prompt_id": pid})
            outs = comfy.wait(pid, on_tick=tick)
            comfy.fetch_output(outs, list(outs.keys()), png)
        elif _hosted_row(model):
            # A hosted pick runs on the model that was PICKED. The provider
            # modules take reference URLs (they post them to someone else's
            # API), not the ComfyUI input paths staged above, so the public
            # keys are handed over instead — the bucket is public, so no bytes
            # pass through here.
            hrow = _hosted_row(model)
            base = (os.environ.get("B2_CDN_BASE")
                    or os.environ.get("VITE_B2_CDN_BASE") or "").rstrip("/")
            urls = []
            for aid in ref_ids[:9]:
                a = sb.asset_by_id(aid)
                if a and a.get("b2_key") and base:
                    urls.append(f"{base}/{a['b2_key']}")
            # Panels default to LOW. Measured on CITY_CAPTURE_2 b5, one prompt
            # and one reference set across all three tiers: the SHOT is right
            # at every tier — the POV, the restraint, the reaching hand, the
            # portal — and what scales is environmental detail. A panel is a
            # reference for a video render, not a deliverable, so the tier that
            # matters is the cheapest one that stages correctly. low is
            # $0.0304/image against medium's $0.0668 and high's $0.1903.
            quality = (payload.get("quality")
                       or ("low" if (payload.get("prompt_spec") or {}).get("kind") == "panel"
                           else "medium"))
            import importlib
            from providers import PROVIDERS
            mod = importlib.import_module(
                f"providers.{PROVIDERS[hrow['provider']]}")
            log(f"image_gen HOSTED {model} ({hrow['provider']}): "
                f"'{prompt[:50]}' {width}x{height} refs={len(urls)} q={quality}")
            out = mod.generate({**job, "payload": {**payload, "prompt": prompt,
                                                   "ref_urls": urls,
                                                   "quality": quality,
                                                   "width": width, "height": height}},
                               hrow)
            hosted_cost = out.get("cost_usd") or 0.0
            # WHICH hosted model actually drew this, and at what tier. `model`
            # alone is the catalog id, and the provider is free to resolve it
            # to something else (gpt-image-2 vs the -2026-04-21 pin), so the
            # row would not otherwise say what produced the picture — which is
            # the question a comparison between models is entirely made of.
            hosted_meta = {k: v for k, v in (out.get("meta") or {}).items()
                           if k in ("hosted_model", "size", "image_size",
                                    "aspect_ratio", "usage")}
            hosted_meta["quality"] = quality
            hosted_meta["cost_usd"] = hosted_cost
            os.replace(out["local_path"], png)
        else:
            # Genuinely no model: neither a local family nor a catalogued
            # hosted row. gpt-image-1.5 is the historical last resort and stays
            # one, but it SAYS it is standing in rather than pretending to be
            # what was asked for.
            size = "1024x1024" if width == height else ("1024x1536" if width < height else "1536x1024")
            log(f"image_gen: no model for '{model}' — falling back to "
                f"gpt-image-1.5 at {size}")
            data = genmedia.generate_image(prompt, ref_image_paths=ref_paths or None,
                                           size=size, quality=payload.get("quality") or "medium",
                                           style="")
            with open(png, "wb") as f:
                f.write(data)
    finally:
        for p in ref_paths:
            try:
                os.remove(p)
            except OSError:
                pass

    grid = payload.get("grid") if isinstance(payload.get("grid"), dict) else None
    if grid and grid.get("scene_id"):
        key = f"stills/grids/{grid['scene_id']}/{jid}.png"
        tags = ["storyboard-grid"]
    elif target.get("block_id"):
        key = f"stills/sheets/{target['block_id']}/{jid}.png"
        tags = ["block-sheet"]
    elif target.get("bible_entry_id"):
        key = f"refs/v2/{target['bible_entry_id']}/{jid}.png"
        tags = ["bible", "candidate"]
    elif target.get("scene_id"):
        key = f"stills/v2/{target['scene_id']}/{jid}.png"
        tags = ["still", "candidate"]
    elif target.get("beat_id"):
        panel = target.get("as") == "panel"
        key = (f"stills/panels/{target['beat_id']}/{jid}.png" if panel
               else f"stills/beats/{target['beat_id']}/{jid}.png")
        tags = ["storyboard-panel"] if panel else ["beat-still", "candidate"]
    else:
        key = f"images/{jid}.png"
        tags = ["image"]
    if hosted_cost:
        # Hosted spend is booked EXACT (estimate=False) — the figure comes from
        # the provider's own usage block, same rule providers.dispatch follows.
        # Without this an image_gen on a hosted row spent money with no
        # cost_ledger row, which is the one thing the api lane never does.
        sb.record_cost(job, hosted_cost, "image", provider=model, estimate=False)
    media.b2_put(png, key, content_type="image/png")
    try:
        from PIL import Image
        with Image.open(png) as im:
            width, height = im.size
    except Exception:
        pass  # keep the requested dims
    asset = sb.register_asset(key, "image", project_id=job.get("project_id"),
                              content_type="image/png", source_job_id=jid,
                              width=width, height=height,
                              meta={"prompt": prompt, "seed": seed,
                                    # A custom graph names its own checkpoint,
                                    # so recording the model_map key the
                                    # picker happened to resolve would state a
                                    # model that never ran. The workflow is
                                    # what rendered it.
                                    **({"workflow_id": custom_id,
                                        "workflow": resolved.get("workflow")}
                                       if custom_id else {"model": model}),
                                    **({"mode": mode} if mode and not custom_id else {}),
                                    # What the PROVIDER did, when one was used.
                                    **hosted_meta,
                                    # what an edit kept, so "why did this change
                                    # so much" is answerable from the row
                                    **({"edited_from": ref_ids[0], "denoise": denoise}
                                       if editing and not custom_id else {}),
                                    **({"requested_model": wanted}
                                       if wanted and wanted != model and not custom_id else {}),
                                    **({"target": target} if target else {})},
                              tags=tags)

    if payload.get("auto_accept") and target.get("bible_entry_id"):
        sb.upsert("bible_assets", {
            "entry_id": target["bible_entry_id"], "asset_id": asset["id"],
            "role": target.get("role") or "master",
            "slot": int(target.get("slot") or 0)}, on_conflict="entry_id,asset_id")
        # NOTE: landing a sheet does NOT confirm the entry, and used to.
        #
        # "A picture rendered" is not "a human approved this": tier 2 exists so
        # the cast can be reviewed before anything is committed, and the sheets
        # are queued by the same plan that drafts the entries — so a plan whose
        # whole point was to be reviewed confirmed itself minutes later, on its
        # own output. Measured: a tier-2 run with `auto_launch: false` came back
        # with all 17 of its invented entries `confirmed`, including two
        # duplicate locations and a protagonist who had been merged away.
        #
        # Canon is now made where the user decides: "Queue episode" in the
        # wizard (`confirmDraftSession`), or `confirm_draft_entries` on the
        # tier-1 path that queues its own render. An entry a session invented
        # also carries `doc.draft_session` until then, which is what makes a
        # discarded draft removable — confirming here would strand that stamp
        # on a row nothing would ever clean up.
    if payload.get("auto_accept") and target.get("block_id"):
        _attach_block_sheet(target["block_id"], asset["id"])
    if payload.get("auto_accept") and target.get("scene_id"):
        sb.patch(f"scenes?id=eq.{target['scene_id']}", {"still_asset_id": asset["id"]})
    if payload.get("auto_accept") and target.get("beat_id"):
        rows = sb.get(f"beats?id=eq.{target['beat_id']}&select=id,meta")
        if rows:
            meta = beat_meta_after(rows[0].get("meta"), asset["id"],
                                   target.get("as"))
            sb.patch(f"beats?id=eq.{target['beat_id']}", {"meta": meta})

    # A storyboard grid is sliced into its per-beat panels here, while the
    # rendered file is still on disk. Panels are enrichment: a slice failure
    # logs loudly and the job still lands with the grid asset — blocks whose
    # beats carry no panel_asset_id simply stage without one.
    if grid and grid.get("beat_ids"):
        try:
            _slice_grid_panels(png, asset, grid, jid, job.get("project_id"))
        except Exception as e:  # noqa: BLE001 — enrichment, never fail the render
            log(f"grid slice FAILED for {jid} ({e}) — beats keep no panels")

    sb.job_done(jid, output_asset_id=asset["id"])
    try:
        os.remove(png)
    except OSError:
        pass
    log(f"JOB DONE image_gen ({model}) -> {key}")


def _attach_block_sheet(block_id, asset_id):
    """Land a segment storyboard on its block.

    The sheet goes on the BLOCK's own params, beside the other per-block
    render flags, so `ref_plan_for` stages it and a re-render keeps it.
    Read-modify-write rather than a column: params is where every other
    per-block choice already lives, and adding one more is not worth a
    migration. Marks a rendered block stale for the same reason a changed
    model does — the composition it renders from just changed — and REWRITES
    THE STORED REF PLAN: a block planned before its sheet existed carries a
    plan with two panels in the sheet's slot, and a master pass reads the
    stored plan unless told to recompute. Shared by the drawn sheet
    (gpt-image, `target.as == "sheet"`) and the composed one
    (`handle_sheet_compose`) so the two cannot drift.
    """
    rows = sb.get(f"generation_blocks?id=eq.{block_id}"
                  f"&select=id,params,status,storyboard_id,scene_ids,beat_ids,"
                  f"chain_from_block_id,audio_mode,mode,idx")
    if not rows:
        log(f"segment storyboard: block {block_id} is gone — sheet {asset_id} unattached")
        return False
    block = rows[0]
    params = dict(block.get("params") or {})
    params["sheet_asset_id"] = asset_id
    patch = {"params": params}
    if block.get("status") == "generated":
        patch["status"] = "stale"
    try:
        from handlers import blocks as B
        story = sb.get(f"storyboards?id=eq.{block['storyboard_id']}"
                       f"&select=id,episode_id,audio_asset_id")[0]
        ep = sb.get(f"episodes?id=eq.{story['episode_id']}&select=id,project_id")[0]
        scenes = sb.get(f"scenes?storyboard_id=eq.{block['storyboard_id']}&order=idx")
        beats = [b for s_ in scenes
                 for b in sb.get(f"beats?scene_id=eq.{s_['id']}&order=idx")]
        ctx = B.ref_plan_ctx(scenes, beats, ep["project_id"],
                             locked=block.get("audio_mode") == "locked")
        patch["ref_plan"] = B.ref_plan_for({**block, "params": params}, ctx, params)
    except Exception as e:  # noqa: BLE001 — the sheet still lands; the plan is advisory
        log(f"segment storyboard: ref plan not recomputed for block {block_id}: {e}")
    sb.patch(f"generation_blocks?id=eq.{block_id}", patch)
    log(f"segment storyboard attached to block {block_id}")
    return True


def handle_sheet_compose(job):
    """Compose a block's per-shot panels into ONE numbered board and attach it.

    The Krea 2 route to a segment storyboard: the panels were rendered one
    per shot (identity-edited from the same sheet, same seed ladder, same
    style clause) and this lays them into the labelled grid `h3_prompt`'s
    `block_sheet` grammar reads — no model, no GPU, PIL only.

    Refuses rather than tiles when the panels disagree: `boardsheet.
    grade_spread` measures hue and brightness agreement first, and a board
    past the ceiling is NOT attached — the block keeps rendering on its two
    panels as before, and the numbers go in the log. Rei E3 b13's four panels
    (95.6deg of hue) tiled into one `fully_preserved` sheet handed H3 four
    films; a missing sheet is recoverable and a confidently wrong one is
    canon for every chained block downstream.

    A beat with no panel (a breath beat, a failed draw) becomes a BLACK cell
    so the numbering stays 1:1 with the shots — the envelope binds shot k to
    panel k, and dropping a cell would shift every later binding.
    """
    from PIL import Image
    import boardsheet
    jid = job["id"]
    payload = job.get("payload") or {}
    block_id = payload.get("block_id")
    if not block_id:
        raise ValueError("sheet_compose needs block_id")
    rows = sb.get(f"generation_blocks?id=eq.{block_id}&select=id,beat_ids,idx,params")
    if not rows:
        raise ValueError(f"block {block_id} is gone")
    block = rows[0]
    beat_ids = list(block.get("beat_ids") or [])
    if len(beat_ids) < 2:
        log(f"sheet_compose: block {block_id} has {len(beat_ids)} shot(s) — nothing to board")
        sb.job_done(jid)
        return
    # `beats` has no still column: BOTH keys live in `meta` (`still_asset_id`
    # is the user's own pick, `panel_asset_id` the auto panel). Selecting a
    # column that does not exist is a PostgREST 400 — which is what the first
    # live launch got, on every block, with `fail_dependents` then taking the
    # whole episode's master passes down behind it (NIGHT SHIFT, 2026-09-02).
    beats = {b["id"]: b for b in sb.get(
        f"beats?id=in.({','.join(beat_ids)})&select=id,meta")}
    panel_ids = []
    for bid in beat_ids:
        b = beats.get(bid) or {}
        meta = b.get("meta") or {}
        # A user's own still outranks the auto panel, the same precedence
        # every surface reads (`beatImageId` in the browser).
        panel_ids.append(meta.get("still_asset_id") or meta.get("panel_asset_id"))
    if not any(panel_ids):
        log(f"sheet_compose: block {block_id} has no panels at all — no board")
        sb.job_done(jid)
        return
    sb.job_progress(jid, 0.2, note="fetching panels")
    tmp, images = [], []
    try:
        for i, aid in enumerate(panel_ids):
            if not aid:
                images.append(None)
                continue
            a = sb.asset_by_id(aid)
            if not a or not a.get("b2_key"):
                images.append(None)
                continue
            dest = f"/tmp/sheet_{jid}_{i}.png"
            media.b2_get(a["b2_key"], dest)
            tmp.append(dest)
            images.append(Image.open(dest).convert("RGB"))
        spread = boardsheet.grade_spread(images)
        drawn = sum(1 for im in images if im is not None)
        if not boardsheet.coherent(spread):
            log(f"sheet_compose: block {block_id} panels DISAGREE — hue spread "
                f"{spread['hue_spread']}deg (ceiling {boardsheet.MAX_HUE_SPREAD}), "
                f"val range {spread['val_range']} — NOT attaching a board; the block "
                f"renders on its panels")
            sb.job_done(jid)
            return
        out = f"/tmp/sheet_{jid}_board.png"
        bw, bh = boardsheet.compose(images, out)
        key = f"stills/sheets/{block_id}/{jid}.png"
        media.b2_put(out, key, content_type="image/png")
        tmp.append(out)
        asset = sb.register_asset(
            key, "image", project_id=job.get("project_id"), content_type="image/png",
            source_job_id=jid, width=bw, height=bh, origin="generated",
            meta={"kind": "block_sheet", "composed_from": panel_ids,
                  "grade_spread": spread, "panels": len(panel_ids),
                  "target": {"block_id": block_id, "as": "sheet"}},
            tags=["block-sheet", "composed"])
        _attach_block_sheet(block_id, asset["id"])
        sb.job_done(jid, output_key=key, output_asset_id=asset["id"])
        log(f"JOB DONE sheet_compose {jid}: block {block.get('idx')} -> {len(panel_ids)} "
            f"cells ({drawn} drawn) {bw}x{bh}, hue spread {spread['hue_spread']}deg")
    finally:
        for p_ in tmp:
            try:
                os.remove(p_)
            except OSError:
                pass

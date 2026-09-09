"""orbit_sheet — a bible entry's reference plates as ONE H3 take.

The job kind behind `graphs.orbit_character_graph` / `orbit_location_graph`.
It renders the sheet, saves EVERY selected view as its own asset (the pack's
own graphs save ONLY the contact sheet, and a single view is what
`image_prompt`, `plate_plan` and every anchor lookup are written against), and
attaches those views to the entry's roles — plus the stitched SHEET itself, in
a role of its own: `turnaround` for a character, `coverage` for a location.
`ref_plan_for` stages that sheet in place of the single-view plate, so a block
spends the same slot and is handed every angle instead of one.

Why this exists rather than more `image_gen` calls: a location's four plates
drawn as four independent renders come back as four crops of one frontal view
when they are drawn on H3 — which is why `sheet_job` forces derived plates
onto krea2 — and a six-view turnaround GRID is a composition the image models
routinely refuse. One take cannot drift between its own views, because every
view IS the same shot.

The old plates are ARCHIVED to `slot >= 90` rather than deleted, the
convention `regen_sheets.py` already uses: every consumer resolves a role with
`order=slot&limit=1`, so the new plate wins the moment it lands and the entry
is never ref-less if a render fails halfway.
"""
import os
import urllib.parse
import urllib.request

import comfy
import graphs
import h3_sheet as HS
import media
import resolve as R
import sb
import staging
from status import log

COMFY_ROOT = os.environ.get("COMFY_ROOT", "/home/ubuntu/ComfyUI")

# Which view of the take fills which bible role, in the order the prompt
# builders emit their shots. `turnaround` takes the WHOLE contact sheet,
# because that is what the role means — six agreeing views at one slot cost,
# which `ref_plan_for` stages in place of full_body. The individual views fill
# the single-view roles beside it, so an entry ends up with both.
#
# `bible_assets.role` is a CHECK-constrained vocabulary, not free text —
# 'ref', 'face', 'full_body', 'side', 'outfit', 'turnaround', 'master',
# 'alt_angle', 'detail', 'atmosphere' and nothing else (migration
# 20260806180000). A role outside it is a PostgREST 400 at the END of a render
# that has already spent its GPU time, which is exactly the trap
# `block_takes_kind_check` is documented for — and which this hit on its first
# live run with 'side_right', 'back', 'scared' and 'rear'.
#
# So the views map onto the legal slots where one fits and onto `ref` where
# none does. Nothing is lost: the specific view is recorded on the ASSET
# (`meta.role`, `meta.view_idx`), which is where a finer label belongs — the
# bible's own vocabulary is about which SLOT a picture fills, and there is no
# slot that means "right profile".
CHAR_VIEW_ROLES = ("full_body", "face", "side", "ref", "ref", "ref")
ENV_VIEW_ROLES = ("master", "alt_angle", "ref", "ref", "atmosphere", "detail")
# What each view actually IS, parallel to the tuples above, for the asset meta
# and the log — so "which one is the back view" stays answerable.
CHAR_VIEW_NAMES = ("full body", "face close-up", "left profile",
                   "right profile", "back", "frightened face")
ENV_VIEW_NAMES = ("front", "right wall", "rear wall", "left wall",
                  "wide establishing", "detail")

# WHICH BIBLE SLOT THE CONTACT SHEET ITSELF FILLS, per kind — and for a
# location this had no answer at all until 2026-09-06.
#
# One take produces two things: the individual views, and the stitched sheet
# carrying all of them. The sheet was saved for a CHARACTER (as `turnaround`,
# which is exactly what that role means) and for a location it was fetched,
# never registered, and deleted with the temp files at the bottom of this
# handler — so a coverage take came out as eight loose plates and the grid it
# had already drawn was thrown away. Nothing errored; the sheet simply did not
# exist to be staged, and `ref_plan_for` went on staging the single master.
#
# `coverage` rather than reusing `turnaround`: a turnaround is a figure
# rotating in front of a fixed camera and coverage is a camera moving around a
# fixed space, which are different plans with different prompts. One name for
# both makes "which sheet is this" unanswerable from the row.
SHEET_ROLE = {"character": "turnaround", "environment": "coverage"}
ARCHIVE_SLOT = 90


def _fetch_all(outputs, nid, dest_dir, stem):
    """Every file a save node produced, in order. `comfy.fetch_output` takes
    the FIRST one, which is right for a single-image render and wrong here —
    the whole point is that the picker returned N views."""
    out = []
    for items in (outputs.get(nid, {}) or {}).values():
        if not isinstance(items, list):
            continue
        for i, it in enumerate(items):
            if not isinstance(it, dict) or "filename" not in it:
                continue
            url = (f"{comfy.COMFY_URL}/view"
                   f"?filename={urllib.parse.quote(it['filename'])}"
                   f"&subfolder={urllib.parse.quote(it.get('subfolder', ''))}"
                   f"&type={it.get('type', 'output')}")
            ext = os.path.splitext(it["filename"])[1] or ".png"
            dest = os.path.join(dest_dir, f"{stem}_{len(out)}{ext}")
            with open(dest, "wb") as f:
                f.write(urllib.request.urlopen(url, timeout=300).read())
            out.append(dest)
    return out


def _h3_files(model_key):
    """The VIDEO entry flattened into what `orbit_sheet_graph` wants.

    A sheet is a video take, so this reads the video entry directly rather
    than an image row's `from_model` indirection — and it wants the **i2v**
    checkpoint (fl2va), because the take opens on a supplied frame. ref2va is
    trained for reference rows and lands on a supplied frame measurably worse.

    `turbo_lora` on a video entry is the WHOLE-model distillation and is
    mode-agnostic — `resolve()` applies it to whichever checkpoint the mode
    selected, with no mode gate — so it is handed to BOTH slots. The image
    entries' per-mode `frame_turbo`/`ref_turbo` split is a different thing:
    lightx2v ships separate fl2v and ref2v BUILDS with their own step counts
    and samplers, and crossing those renders silently wrong.

    Filling one slot only was right while `orbit` was the sole shape (it opens
    on a frame, so fl2va). `coverage` loads the ref2va trunk and reads
    `ref_turbo`, so a coverage sheet on a turbo model found nothing there and
    quietly rendered the full 25-step schedule instead of the distilled 6 —
    slower and correct, which is exactly the kind of downgrade nothing reports.
    """
    src = R.ensure_model(model_key)
    modes = src.get("modes") or {}
    out = {
        "frame_checkpoint": (modes.get("i2v") or {}).get("checkpoint"),
        # The REFERENCE checkpoint, for the `coverage` shape. i2v opens on one
        # supplied frame and r2v conditions on a set of up to nine, so which
        # one is correct is decided by the sheet mode and not by the entry.
        "ref_checkpoint": (modes.get("r2v") or {}).get("checkpoint"),
        "checkpoint": (modes.get("i2v") or {}).get("checkpoint"),
        "text_encoder": (src.get("text_encoders") or [None])[0],
        "vae": src.get("vae"),
        "audio_vae": src.get("audio_vae"),
        "steps": src.get("steps"),
        "sampler": src.get("sampler"),
        "scheduler": src.get("scheduler"),
        "lora_strength": src.get("lora_strength", 1.0),
    }
    if src.get("turbo_lora"):
        # BOTH, because this one adapter is the whole model's — see above. The
        # two slots carry the same dict rather than one being derived from the
        # other at the reader, so whichever shape a sheet loads finds it.
        turbo = {"lora": src["turbo_lora"],
                 "strength": src.get("turbo_strength", 1.0),
                 "steps": src.get("steps")}
        out["frame_turbo"] = dict(turbo)
        out["ref_turbo"] = dict(turbo)
    if src.get("pdd"):
        out["pdd"] = src["pdd"]
    return out


# The bible roles a sheet stages, in the order they reach the node. <Picture N>
# is POSITIONAL and slot 1 carries the highest token budget, so this is a
# ranking and not a list: a character leads with the FACE (the identity anchor
# every other plate is derived from) and a location with its MASTER.
CHAR_REF_ROLES = ("face", "turnaround", "full_body", "outfit", "side")
# `coverage` sits SECOND for the reason `turnaround` does on the character
# side: the single-view anchor leads (slot 1 carries the highest token budget
# and a full-frame plate is the least ambiguous thing to put there), and the
# sheet follows as the picture that resolves every surface the master does not
# show. `picture_line` tells the model to ignore its grid.
ENV_REF_ROLES = ("master", "coverage", "alt_angle", "detail", "atmosphere")
# The node's own ceiling, and more than any other local image model takes.
MAX_SHEET_REFS = 9


def _sheet_refs(entry):
    """Every plate this entry has, best-anchor-first, capped at the node's nine.

    This is the whole reason the `coverage` shape exists: `_anchor` picks ONE
    picture and the other four an entry usually holds are discarded, which on a
    turnaround means the render that is supposed to RECONCILE a face plate and
    a body sheet is shown one of them. Archived rows (`slot >= 90`) are
    excluded — a withdrawal is not a preference, and ordering alone would let a
    replaced plate back in whenever its replacement had not landed yet.
    """
    roles = CHAR_REF_ROLES if entry["kind"] == "character" else ENV_REF_ROLES
    out, seen = [], set()
    for role in roles:
        rows = sb.get(f"bible_assets?entry_id=eq.{entry['id']}&role=eq.{role}"
                      f"&slot=lt.{ARCHIVE_SLOT}&select=asset_id&order=slot&limit=1")
        if not rows or rows[0]["asset_id"] in seen:
            continue
        a = sb.asset_by_id(rows[0]["asset_id"])
        if a:
            seen.add(rows[0]["asset_id"])
            out.append((role, a))
    return out[:MAX_SHEET_REFS]


def _anchor(entry):
    """The picture the take opens on.

    A character's turn must open on a FULL BODY — shot 1 of the prompt is the
    full figure, so opening on a head-and-shoulders face plate contradicts the
    take's own first instruction. A location opens on its master.
    """
    roles = (("full_body", "turnaround", "outfit", "face")
             if entry["kind"] == "character" else ("master", "alt_angle"))
    for role in roles:
        rows = sb.get(f"bible_assets?entry_id=eq.{entry['id']}&role=eq.{role}"
                      f"&slot=lt.{ARCHIVE_SLOT}&select=asset_id&order=slot&limit=1")
        if rows:
            a = sb.asset_by_id(rows[0]["asset_id"])
            if a:
                return a, role
    return None, None


def _probe_ms(path):
    """The voice sample's length, or 0 when nothing can measure it.

    `media.probe` shells out to ffprobe, and this runs AFTER the take has been
    sampled — so on a machine without it (the engine window's "Utilities only"
    is what puts one there, and a GUI-launched app does not inherit a shell
    PATH) an unguarded probe fails a render that has already succeeded, over a
    number `asset_ingest` fills in anyway. `plan_cli.KINDS` marks this kind
    "comfy" for the same reason: demanding ffmpeg would refuse a coverage
    sheet, which is silent and needs none.
    """
    try:
        return int(media.probe(path).get("duration_ms") or 0)
    except Exception as e:                          # noqa: BLE001
        log(f"orbit sheet: could not measure the voice sample ({e}) — "
            f"registering it without a duration")
        return 0


def handle_orbit_sheet(job):
    jid = job["id"]
    payload = job.get("payload") or {}
    entry_id = payload.get("entry_id")
    if not entry_id:
        raise ValueError("orbit_sheet needs an entry_id")
    rows = sb.get(f"bible_entries?id=eq.{entry_id}"
                  f"&select=id,kind,name,identity_line,summary,doc,project_id")
    if not rows:
        raise ValueError(f"bible entry {entry_id} no longer exists")
    entry = rows[0]
    if entry["kind"] not in ("character", "environment"):
        raise ValueError(f"orbit_sheet has no sheet shape for a "
                         f"{entry['kind']} entry")

    project = sb.get(f"projects?id=eq.{entry['project_id']}"
                     f"&select=style,settings")[0]
    style = project.get("style") or ""
    # `coverage` is the default because it needs no custom pack and stages the
    # whole reference set; `orbit` is the i2v path that predates it, kept
    # reachable because it is the one that has a voice sample.
    mode = str(payload.get("sheet_mode") or "coverage").lower()
    if mode not in ("coverage", "orbit"):
        raise ValueError(f"unknown sheet_mode {mode!r} — 'coverage' or 'orbit'")
    h3 = _h3_files(payload.get("model_key")
                   or ("minimax-h3-pdd" if mode == "coverage"
                       else "minimax-h3-turbo"))
    desc = entry.get("identity_line") or entry.get("summary") or entry["name"]
    seed = int(payload.get("seed") or 0) or (abs(hash(entry_id)) % 2_000_000_000)
    is_char = entry["kind"] == "character"
    prefix = f"qamba/orbit/{jid}"
    staged = []

    if mode == "coverage":
        if not h3.get("ref_checkpoint"):
            raise ValueError(
                f"'{payload.get('model_key') or 'minimax-h3-pdd'}' declares no "
                f"r2v mode — a coverage sheet conditions on a reference set")
        refs = _sheet_refs(entry)
        if not refs:
            raise ValueError(
                f"'{entry['name']}' has no reference plates to build a sheet "
                f"from — draw its face or master plate first")
        for i, (role, a) in enumerate(refs):
            ext = os.path.splitext(a["b2_key"])[1] or ".png"
            nm = f"qamba_orbit_{jid}_{i}{ext}"
            media.b2_get(a["b2_key"], os.path.join(COMFY_ROOT, "input", nm))
            staged.append(nm)
        anchor_role = refs[0][0]
        plan = (HS.plan_character(fast=bool(payload.get("fast")))
                if is_char else HS.plan_location())
        prompt = HS.sheet_prompt(
            plan, name=entry["name"], identity=desc,
            pictures=[{"role": r} for r, _a in refs], style=style,
            target=payload.get("coverage_target"))
        w, h = plan["dims"]
        # A distilled row hands its own acceleration over; a plain one renders
        # the published 25 steps. Either way the sampler is the graph's.
        #
        # The PDD default DEGRADES rather than failing when its pack is not
        # installed, and that is the opposite call from a user's LoRA pick on
        # purpose: a dropped pick renders something the user did not ask for,
        # where dropping this renders the SAME sheet at 25 steps instead of 8.
        # Slower is not a silent downgrade — it is said in the log — and a
        # sheet that fails outright on a box without the pack is much worse.
        from handlers.images import _has_node
        if h3.get("pdd") and not _has_node("MiniMaxH3PDDAccApply"):
            log("sheet coverage: MiniMaxH3PDDAccApply is not installed — "
                "rendering the full schedule instead of the 8-step "
                "distillation (install ComfyUI-MiniMax-H3-PDD-Acc)")
            h3 = dict(h3)
            h3.pop("pdd")
        g = graphs.h3_sheet_graph(
            h3, prompt, seed, refs=staged,
            frames=[v["frame"] for v in plan["views"]], length=plan["length"],
            width=w, height=h, columns=plan["columns"], prefix=prefix,
            steps=payload.get("steps"), pdd=h3.get("pdd"),
            node_spec=comfy.object_info().get("MiniMaxH3ReferenceToVideo"),
            batch_spec=comfy.object_info().get("BatchImagesNode"))
        roles = tuple(v["role"] for v in plan["views"])
        view_names = tuple(v["label"] for v in plan["views"])
        columns = plan["columns"]
        view_node, sheet_node = "301", "302"
        log(f"sheet coverage: {entry['name']} · {len(refs)} ref(s) "
            f"({', '.join(r for r, _a in refs)}) -> {len(plan['views'])} view(s) "
            f"{w}x{h}x{plan['length']}f"
            + (f" pdd@{h3['pdd'].get('nfe', '8')}nfe" if h3.get("pdd") else ""))
    else:
        if not h3.get("frame_checkpoint"):
            raise ValueError(
                f"'{payload.get('model_key') or 'minimax-h3-turbo'}' declares "
                f"no i2v mode — an orbit sheet opens on a supplied frame")
        anchor_asset, anchor_role = _anchor(entry)
        if not anchor_asset:
            raise ValueError(
                f"'{entry['name']}' has no {'full body or face' if is_char else 'master'} "
                f"plate to open the take on — draw its anchor sheet first")
        ext = os.path.splitext(anchor_asset["b2_key"])[1] or ".png"
        name = f"qamba_orbit_{jid}{ext}"
        media.b2_get(anchor_asset["b2_key"], os.path.join(COMFY_ROOT, "input", name))
        staged.append(name)
        spec = comfy.object_info().get("MiniMaxH3ImageToVideo")
        if is_char:
            # The line is what makes the same pass produce a voice-timbre
            # reference. It is deliberately CONTENT-FREE — a sheet's audio is a
            # timbre anchor, not a performance, and putting story words in it
            # would make the anchor carry a line the character never says.
            line = payload.get("spoken_line")
            if line is None:
                line = (f"Hello. My name is {entry['name']}, and this is how my "
                        f"voice sounds when I speak plainly.")
            g = graphs.orbit_character_graph(
                h3, desc, seed, anchor=name, style=style, spoken_line=line,
                voice_description=(entry.get("doc") or {}).get("voice") or "",
                prefix=prefix, node_spec=spec)
            roles, view_names = CHAR_VIEW_ROLES, CHAR_VIEW_NAMES
        else:
            g = graphs.orbit_location_graph(
                h3, desc, seed, anchor=name, style=style,
                space=str((entry.get("doc") or {}).get("space") or "interior"),
                prefix=prefix, node_spec=spec)
            roles, view_names = ENV_VIEW_ROLES, ENV_VIEW_NAMES
        # `orbit_sheet_graph`'s own default, and nothing on this path overrides
        # it. It rides the asset so the compiler can say how to READ the sheet.
        columns = 2
        view_node, sheet_node = "62", "63"

    sb.job_progress(jid, 0.1, note=f"{mode} sheet · {entry['name']}")
    pid = comfy.submit(g)
    # `make_tick` is the shared on_tick: `sampling_progress()` hands back
    # `(done, total)` or None, NOT a float, and it also honours cancellation.
    # Rolling my own lambda here multiplied a tuple by 0.7 and killed the job
    # on its first poll — four seconds in, after the model had loaded.
    from handlers.common import make_tick
    outs = comfy.wait(pid, on_tick=make_tick(job), timeout=1800)

    tmp = f"/tmp/orbit_{jid}"
    os.makedirs(tmp, exist_ok=True)
    views = _fetch_all(outs, view_node, tmp, "view")
    sheets = _fetch_all(outs, sheet_node, tmp, "sheet")
    if not views:
        raise ValueError("the orbit take produced no selected views")
    log(f"orbit sheet: {len(views)} view(s) + {len(sheets)} sheet(s) "
        f"for {entry['name']} ({entry['kind']}, anchored on {anchor_role})")

    # Archive first, so a failure between here and the writes leaves the entry
    # with its OLD plates rather than none.
    sheet_role = SHEET_ROLE.get(entry["kind"])
    touched = set(roles[:len(views)]) | ({sheet_role} if sheets and sheet_role
                                         else set())
    for role in touched:
        for row in sb.get(f"bible_assets?entry_id=eq.{entry_id}&role=eq.{role}"
                          f"&slot=lt.{ARCHIVE_SLOT}&select=asset_id,slot"):
            sb.patch(f"bible_assets?entry_id=eq.{entry_id}"
                     f"&asset_id=eq.{row['asset_id']}",
                     {"slot": ARCHIVE_SLOT + int(row.get("slot") or 0)})

    made = []
    for i, path in enumerate(views):
        role = roles[i] if i < len(roles) else "ref"
        view = view_names[i] if i < len(view_names) else f"view {i}"
        key = f"refs/v2/{entry_id}/orbit_{jid}_{i}.png"
        media.b2_put(path, key, content_type="image/png")
        asset = sb.register_asset(
            key, "image", project_id=entry["project_id"],
            content_type="image/png", source_job_id=jid, origin="generated",
            meta={"orbit": True, "role": role, "view": view,
                  "view_idx": i, "seed": seed,
                  "anchor_role": anchor_role, "entry_id": entry_id},
            tags=["bible", "orbit"])
        sb.upsert("bible_assets",
                  {"entry_id": entry_id, "asset_id": asset["id"],
                   "role": role, "slot": 0}, on_conflict="entry_id,asset_id")
        made.append((role, asset["id"], view))

    if sheets and sheet_role:
        key = f"refs/v2/{entry_id}/orbit_{jid}_sheet.png"
        media.b2_put(sheets[0], key, content_type="image/png")
        asset = sb.register_asset(
            key, "image", project_id=entry["project_id"],
            content_type="image/png", source_job_id=jid, origin="generated",
            # `views` and `columns` are what the COMPILER needs to describe the
            # picture: "the complete eight-view coverage sheet, read
            # left-to-right then top-to-bottom" is only sayable if the count
            # travels with the asset. Deriving it downstream from the view rows
            # would go stale the moment a redraw renders a different plan, and
            # the compiler must describe the PICTURE — the same rule
            # `block_sheet`'s `panels` already follows.
            meta={"orbit": True, "role": sheet_role, "seed": seed,
                  "views": len(views), "columns": columns,
                  "entry_id": entry_id},
            tags=["bible", "orbit"])
        sb.upsert("bible_assets",
                  {"entry_id": entry_id, "asset_id": asset["id"],
                   "role": sheet_role, "slot": 0}, on_conflict="entry_id,asset_id")
        made.append((sheet_role, asset["id"], "contact sheet"))

    # The voice sample, when the take spoke. Registered as the entry's
    # voice-timbre reference the same way `handle_tts` does with
    # `bible_entry_id` — but only when the entry has none, because that key is
    # the speaker verifier's ground truth and silently re-baselining it would
    # move every similarity score in `take_reviews`.
    voice = _fetch_all(outs, "53", tmp, "voice")
    if voice and entry["kind"] == "character":
        key = f"refs/v2/{entry_id}/orbit_{jid}_voice{os.path.splitext(voice[0])[1]}"
        media.b2_put(voice[0], key, content_type="audio/flac")
        va = sb.register_asset(
            key, "audio", project_id=entry["project_id"],
            content_type="audio/flac", source_job_id=jid, origin="generated",
            duration_ms=_probe_ms(voice[0]),
            meta={"orbit": True, "entry_id": entry_id, "kind_hint": "voice"},
            tags=["voiceover", "orbit"])
        rows = sb.get(f"bible_entries?id=eq.{entry_id}&select=voice_ref_asset_id")
        if not (rows and rows[0].get("voice_ref_asset_id")):
            sb.patch(f"bible_entries?id=eq.{entry_id}",
                     {"voice_ref_asset_id": va["id"]})
            log(f"orbit sheet: {entry['name']} had no voice reference — "
                f"the take's own audio is now the timbre anchor")

    staging.sweep_job(jid)
    for p in views + sheets + voice:
        try:
            os.remove(p)
        except OSError:
            pass
    sb.job_done(jid, output_asset_id=made[0][1] if made else None)
    log(f"JOB DONE orbit_sheet {entry['name']}: "
        + ", ".join(f"{v}->{r}" for r, _a, v in made))

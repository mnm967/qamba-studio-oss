"""Dialogue spine — ONE continuous recorded audio track for a storyboard,
locked across the blocks it covers.

This is the community "lipsync automatic long-video chaining" mechanism
(Ltamann's Auto-Chain addon, the multishot pack's `guide_audio` audio spine)
built out of machinery this studio already ships: the dialogue recordings are
`dialogue_synth`'s own exchange/line clips, the per-block slicing with a
warmup lead-in is `handle_audio_slice` (unchanged — a spine block points its
`audio_slice.asset_id` at the spine), the render is the r2v audiolock graph,
and the delivered audio is the spine itself (fully_copy), so concatenated
takes reconstruct the continuous recording with NO seam in the sound.

What that buys over placing recordings as reference audio per block:
  - a line can never be cut at a chain join — the audio is ground truth and
    the joins land in it, not in a per-block re-placement;
  - placement stops being solved per block (`place_exchange`'s feasibility
    dance, measured fragile on E2) — the recording sits at its absolute
    plan-time offsets once, here;
  - the 3-audio-slot ceiling disappears — the spine arrives on the audiolock
    graph's own audio input, so a block can carry any number of lines.

What it costs: between lines the room is the spine's own bed, not H3's
generated ambience — so the spine carries a gentle synthesized room tone
under everything rather than digital silence. Blocks with no dialogue in
range stay `native` and keep H3's full soundscape.

All-or-nothing per storyboard: if any run cannot be synthesized or placed,
the whole spine is abandoned (the caller falls back to the native per-block
staging). A spine that silently missed a run would compile an envelope
claiming lines <Audio 1> does not contain.
"""
import hashlib
import os
import subprocess

import media
import sb
from status import log

# Room tone under the dialogue, and the level is MEASURED against the thing it
# has to sit beside rather than chosen.
#
# The locked path delivers <Audio 1> as the final track 1:1 (the audiolock
# graph's VRGDG node passes the source audio straight to CreateVideo), so
# whatever is not in this file is DIGITAL SILENCE — which is exactly what the
# music-video audiolock ships between vocals, and in a dialogue scene reads as
# the sound dropping out between lines. H3's own generated ambience floor
# between lines was measured at about -44 dB, so a bed quieter than that makes
# a spine block audibly step down from a native one at the join.
#
# Swept on the pod against ebur128 (3s of pink noise, integrated):
#   amp .0045 lp 700 -> -67.7 |  amp .02 lp 2000 -> -52.7
#   amp .05   lp 700 -> -46.8 |  amp .05 lp 2000 -> -44.6  <- chosen
#   amp .09   lp 700 -> -41.6 |  amp .09 lp 2000 -> -39.5
# 0.05 / 2000 Hz lands on -44.6 LUFS, i.e. on H3's own floor; 700 Hz was the
# first guess and is audibly muffled for a room rather than a rumble.
BED_AMPLITUDE = 0.05
BED_LOWPASS_HZ = 2000


def _runs(scenes, scene_beats):
    """Consecutive-dialogue-beat runs with ABSOLUTE storyboard time.

    Returns [{"beats": [{"beat", "abs_ms", "dur_ms", "idx_in_run"}...]}] in
    order. The absolute clock is the planner's own: beats accumulate in scene
    idx order, exactly as `plan_blocks` walks them.
    """
    runs, t = [], 0
    for s in scenes:
        cur = None
        for b in scene_beats[s["id"]]:
            dur = int(b.get("duration_ms") or 0)
            if b.get("dialogue"):
                if cur is None:
                    cur = []
                    runs.append(cur)
                cur.append({"beat": b, "abs_ms": t, "dur_ms": dur,
                            "idx_in_run": len(cur) + 1})
            else:
                cur = None
            t += dur
        # A run never crosses a scene boundary: a location cut is a hard block
        # boundary too, so a recording spanning one would be locked into two
        # blocks that do not adjoin in the finished cut.
        cur = None
    return runs


def _run_recording(run, cast, project_id):
    """One run -> (asset_row, clip_lines, abs_offset_ms) or None.

    clip_lines are in CLIP time; abs_offset_ms is where clip-time 0 sits on
    the storyboard clock. Prefers the plan-time pinned recording (the shots
    were CUT to it, so its placement is exact by construction); otherwise
    synthesizes and solves placement the way `place_exchange` does, against
    the run's own absolute windows.
    """
    import dialogue_synth as DS

    run_beats = [r["beat"] for r in run]
    items = DS.plan_lines(run_beats, cast)
    if items is None:
        return None                      # uncast speaker etc. — caller aborts

    # windows in RUN-relative time (plan_lines numbered shots 1..n over these)
    windows, t0 = {}, run[0]["abs_ms"]
    for r in run:
        windows[r["idx_in_run"]] = (r["abs_ms"] - t0,
                                    r["abs_ms"] - t0 + r["dur_ms"])

    aids = {((r["beat"].get("meta") or {}).get("xchg") or {}).get("asset_id")
            for r in run}
    aids.discard(None)
    if len(aids) == 1:
        a = sb.asset_by_id(next(iter(aids)))
        meta_lines = ((a or {}).get("meta") or {}).get("lines") or []
        if a and len(meta_lines) == len(items) and all(
                (ml.get("line") or "").strip() == it["line"].strip()
                for ml, it in zip(meta_lines, items)):
            lines = [{**it, "t0_ms": ml["t0_ms"], "t1_ms": ml["t1_ms"]}
                     for it, ml in zip(items, meta_lines)]
            # `pin_run_durations` opened the run lead_ms before the first word,
            # so clip-time (t0_first - lead) sits at the run's absolute start.
            off_rel = max(0, lines[0]["t0_ms"] - DS.SHOT_LEAD_MS)
            # ...but VERIFY it rather than trusting it. The pin is only exact
            # while the beats are still the ones that were cut to this
            # recording, and they need not be: a re-plan retimes beats,
            # `refit_beats` scales them, and `update_beat` clears the pin only
            # when the WORDS change. A stale pin that still matches by text
            # would put every line at the offset the old durations implied —
            # which is a line landing in its neighbour's shot, silently. When
            # the check fails the recording is still right, so fall through
            # and SOLVE the placement instead of abandoning the run.
            if all(w[0] <= l["t0_ms"] - off_rel and l["t1_ms"] - off_rel <= w[1]
                   for l, w in ((l, windows[l["shot_idx"]]) for l in lines)):
                return a, lines, t0 - off_rel
            log(f"dialogue spine: run at {t0}ms carries a pinned recording "
                f"whose lines no longer land in their own shots (the beats "
                f"were retimed after it was cut) — re-solving placement")
            block_ms = max(s1 for _s0, s1 in windows.values())
            p = DS.place_exchange(lines, windows,
                                  clip_ms=int(a.get("duration_ms") or 0),
                                  block_ms=block_ms)
            if p is not None:
                return a, lines, t0 + p
            log(f"dialogue spine: run at {t0}ms — exact fit infeasible, "
                f"placing by ONSETS (tails stay graceful)")
            return a, lines, t0 + place_onsets(lines, windows)

    if len(items) == 1:
        it = items[0]
        aid = DS._ensure_line_asset(it, project_id)
        a = sb.asset_by_id(aid)
        dur = int((a or {}).get("duration_ms") or 0)
        lines = [{**it, "t0_ms": 0, "t1_ms": dur}]
        win = windows[1]
        # lead-in, but never past the point where the line's tail leaves the beat
        off_rel = min(DS.SHOT_LEAD_MS, max(0, win[1] - DS.SHOT_TAIL_MS - dur))
        return a, lines, t0 + off_rel

    x = DS.ensure_exchange_asset(items, project_id)
    a = sb.asset_by_id(x["asset_id"])
    lines = [{**it, "t0_ms": xl["t0_ms"], "t1_ms": xl["t1_ms"]}
             for it, xl in zip(items, x["lines"])]
    block_ms = max(s1 for _s0, s1 in windows.values())
    p = DS.place_exchange(lines, windows,
                          clip_ms=int(a.get("duration_ms") or 0),
                          block_ms=block_ms)
    if p is None:
        # With a spine the audio itself cannot be cut, so an infeasible fit
        # degrades — but never to "align the first word and let the rest
        # drift": that is how 19 of 92 onsets ended up before their own
        # beats, ten of them beheaded at a beat edge. Satisfy the ONSETS
        # (the thing lip-binding needs) and let tails run over their cuts,
        # which the continuous spine makes graceful.
        p = place_onsets(lines, windows)
        log(f"dialogue spine: run at {t0}ms — recorded pacing does not fit "
            f"the planned cuts exactly; placed by onsets (audio stays "
            f"continuous, tails may cross cuts)")
    return a, lines, t0 + p


def place_onsets(lines, windows, *, head_ms=250, tail_eps_ms=200,
                 lead_ms=700):
    """Fallback placement when `place_exchange` is infeasible: satisfy the
    ONSETS, and let the tails go where the recording takes them.

    `place_exchange` demands every line WHOLLY inside its shot window, which a
    conversation recording's own turn-taking rhythm routinely cannot give —
    and the old fallback then aligned only the FIRST word and let every later
    line drift. Measured on THE LATE SHIFT: 4 of 87 dialogue beats were
    pinned (short sitcom volleys never take the pinning path), so nearly
    every run fell through, and 19 of the spine's 92 lines started BEFORE
    their own beat — ten of them straddling a beat edge. Where that edge was
    also a BLOCK edge, the owning block's slice opens mid-word: no onset, and
    H3 has nothing to bind the mouth to. Measured directly: Dennis's mouth
    closed through his whole line in b1 AND b3 (his onsets sat outside his
    shot both times) while Priya's moved (hers landed 250ms inside).

    A tail crossing forward stays the documented graceful case — the spine is
    continuous, so the line completes over the cut like a real edit. An onset
    crossing BACKWARD is what this refuses: the mouth's owner is not on
    screen yet, and the block that owns the line hears it beheaded.

    Returns the offset p, or the best-effort p satisfying the most onsets
    when no p satisfies all (deterministic tie-break: closest to the natural
    lead). Pure.
    """
    if not lines:
        return 0
    pref = lead_ms - lines[0]["t0_ms"]

    def interval(head):
        lo, hi = None, None
        for l in lines:
            w = windows.get(l["shot_idx"])
            if not w:
                continue
            a = w[0] + head - l["t0_ms"]
            b = (w[1] - tail_eps_ms) - l["t0_ms"]
            lo = a if lo is None else max(lo, a)
            hi = b if hi is None else min(hi, b)
        return (lo, hi)

    for head in (head_ms, 30):
        lo, hi = interval(head)
        if lo is not None and lo <= hi:
            return max(lo, min(hi, pref))

    # No p satisfies every onset: take the candidate satisfying the most.
    def score(p):
        ok = 0
        for l in lines:
            w = windows.get(l["shot_idx"])
            if w and w[0] <= l["t0_ms"] + p <= w[1] - tail_eps_ms:
                ok += 1
        return ok

    cands = {pref}
    for l in lines:
        w = windows.get(l["shot_idx"])
        if w:
            cands.add(w[0] + 30 - l["t0_ms"])
    best = max(sorted(cands), key=lambda p: (score(p), -abs(p - pref)))
    return best


def build_for_storyboard(scenes, scene_beats, story, ep, project_id):
    """Build (or reuse) the storyboard's dialogue spine.

    Returns {"asset_id", "spans": [(a_ms, b_ms)...], "lines": [...abs...]}
    or None when the storyboard has no dialogue. Raises on any failure —
    the caller falls back to the native path loudly.
    """
    import dialogue_synth as DS
    if not DS.enabled():
        raise RuntimeError("ELEVENLABS_API_KEY unset — no recordings to spine")

    cast = sb.get(f"bible_entries?project_id=eq.{project_id}"
                  f"&kind=eq.character&select=id,name,identity_line,doc")
    runs = _runs(scenes, scene_beats)
    if not runs:
        return None

    total_ms = sum(int(b.get("duration_ms") or 0)
                   for s in scenes for b in scene_beats[s["id"]])
    placed = []
    for run in runs:
        got = _run_recording(run, cast, project_id)
        if got is None:
            raise RuntimeError(
                f"run at {run[0]['abs_ms']}ms has an uncast speaker — spine "
                f"needs every speaker cast (falling back to native staging)")
        asset, lines, off = got
        # Which BEAT each line belongs to, by the run's own shot numbering —
        # `plan_lines` numbered shots 1..n over these beats, so the mapping is
        # exact rather than inferred from time. It is what lets the compiler
        # RETIME its shot stamps to the recording (see `retime_beats`): a
        # placement is only useful downstream if the consumer can say which
        # shot each span was placed FOR.
        by_idx = {r["idx_in_run"]: r["beat"] for r in run}
        for l in lines:
            b = by_idx.get(l.get("shot_idx"))
            if b is not None:
                l["beat_id"] = b.get("id")
        placed.append({"asset": asset, "lines": lines, "off_ms": int(off)})

    # Two ways the placed recordings can disagree with the timeline, both of
    # which the mix would otherwise resolve silently: `-t` truncates a
    # recording that runs past the end of the storyboard (the last line simply
    # stops), and `amix` SUMS two that overlap (two conversations at once).
    # Neither is recoverable downstream and neither is visible in the output
    # without listening, so they are reported here. Not fatal: a placement
    # that is slightly wrong is still far better than the per-block path this
    # replaces, and refusing the whole spine over one long tail would throw
    # away the fix for every other run.
    for i, p in enumerate(placed):
        end = p["off_ms"] + int(p["asset"].get("duration_ms") or 0)
        if end > total_ms:
            log(f"dialogue spine: the run at {p['off_ms']}ms ends {end - total_ms}ms "
                f"past the end of the storyboard and will be cut there — its "
                f"last line may lose its tail")
        if i + 1 < len(placed) and end > placed[i + 1]["off_ms"]:
            log(f"dialogue spine: the run at {p['off_ms']}ms overlaps the next "
                f"by {end - placed[i + 1]['off_ms']}ms — they will play over "
                f"each other")

    # Content-addressed: a relaunch with unchanged dialogue reuses the file.
    key_src = "|".join(f"{p['asset']['b2_key']}@{p['off_ms']}" for p in placed)
    h = hashlib.sha1(f"spine|{total_ms}|{key_src}".encode()).hexdigest()[:16]
    b2_key = f"blocks/{ep['code']}/spine_{h}.wav"
    import urllib.parse
    rows = sb.get(f"assets?b2_key=eq.{urllib.parse.quote(b2_key)}&select=id,meta")
    if rows:
        meta = rows[0].get("meta") or {}
        return {"asset_id": rows[0]["id"], "spans": meta.get("spans") or [],
                "lines": meta.get("lines") or []}

    locals_, filters, mixes = [], [], []
    T = total_ms / 1000.0
    for i, p in enumerate(placed):
        lp = f"/tmp/spine_{h}_{i}{os.path.splitext(p['asset']['b2_key'])[1] or '.mp3'}"
        media.b2_get(p["asset"]["b2_key"], lp)
        locals_.append(lp)
        d = max(0, p["off_ms"])
        filters.append(f"[{i}:a]aformat=channel_layouts=stereo:sample_rates=44100,"
                       f"adelay={d}|{d}[c{i}]")
        mixes.append(f"[c{i}]")
    filters.insert(0, f"anoisesrc=d={T:.3f}:colour=pink:amplitude={BED_AMPLITUDE},"
                      f"lowpass=f={BED_LOWPASS_HZ},"
                      f"aformat=channel_layouts=stereo:sample_rates=44100[bed]")
    fc = ";".join(filters) + f";[bed]{''.join(mixes)}amix=inputs={len(placed) + 1}" \
                             f":normalize=0:duration=first[out]"
    out = f"/tmp/spine_{h}.wav"
    args = ["ffmpeg", "-v", "error", "-y"]
    for lp in locals_:
        args += ["-i", lp]
    args += ["-filter_complex", fc, "-map", "[out]",
             "-t", f"{T:.3f}", "-ar", "44100", "-ac", "2", out]
    subprocess.run(args, check=True)

    abs_lines = [{"speaker": l["speaker"], "line": l["line"],
                  **({"beat_id": l["beat_id"]} if l.get("beat_id") else {}),
                  "t0_ms": p["off_ms"] + l["t0_ms"],
                  "t1_ms": p["off_ms"] + l["t1_ms"]}
                 for p in placed for l in p["lines"]]
    spans = [(p["off_ms"],
              p["off_ms"] + int(p["asset"].get("duration_ms") or 0))
             for p in placed]
    try:
        media.b2_put(out, b2_key, content_type="audio/wav")
        asset = sb.register_asset(
            b2_key, "audio", project_id=project_id, content_type="audio/wav",
            duration_ms=total_ms, origin="generated",
            meta={"kind": "dialogue_spine", "storyboard_id": story["id"],
                  "spans": spans, "lines": abs_lines},
            tags=["dialogue-spine"])
    finally:
        for lp in locals_ + [out]:
            try:
                os.remove(lp)
            except OSError:
                pass
    log(f"dialogue spine: {len(placed)} run(s), {len(abs_lines)} line(s) "
        f"placed on a {total_ms}ms track ({b2_key})")
    return {"asset_id": asset["id"], "spans": spans, "lines": abs_lines}


def locks(block_beat_ids, beats_by_id):
    """Whether this block locks to the spine.

    The test is whether the block HOLDS a dialogue beat, not whether its
    window overlaps a recording's span: a recording can run shorter than the
    beats it was cut against, and a block whose last beat then fell outside
    every span would render its own speech over a track that already contains
    it. Blocks with no dialogue deliberately stay native — H3's generated
    soundscape is richer than this module's room tone, and there are no words
    in them to protect.
    """
    return any((beats_by_id.get(bid) or {}).get("dialogue")
               for bid in (block_beat_ids or []))


# ---------------------------------------------------------------------------
# THE RECORDING IS THE CLOCK, and the envelope's shot stamps have to agree
# with it or the lip-binding silently fails.
#
# Measured on THE LATE SHIFT b1 (the first block of the first render):
# the envelope stamped [Shot 3] at 00:06.864 and bound Dennis's line to it
# "precisely lip-synced" — and the spine's audio has him starting at 5.69s,
# 1.17s earlier, during an insert close-up of a BELL in which he is not even
# on screen. H3, told one clock and played another, animated nothing: his
# line plays over a closed mouth. The reviewer scored dialogue 1.0 (the words
# are all there — the audio is the spine 1:1) so nothing downstream can catch
# it; only the picture shows it.
#
# The drift is structural, not a bug in placement: `place_exchange` fits a
# recording's own rhythm into beat windows the writer planned, and when the
# rhythm does not fit (a lead-in fallback, a stale pin re-solve, plain
# quantisation) the AUDIO moves while the STAMPS stay planned. This is the
# vrgamedevgirl PR #158 idea ("cue maps control shot boundaries") done
# deterministically: at compile time, move each cut to where the recording
# actually put the speech. Pure, so it is testable off-pod.

def retime_beats(beats, lines, block_ms, *, min_shot_ms=600,
                 lead_ms=250, tail_ms=120):
    """Adjust beat durations so each line lands inside its own beat.

    `beats`: ordered [{"id", "duration_ms", ...}] whose durations sum to
    `block_ms` (content clock). `lines`: [{"beat_id", "t0_ms", "t1_ms"}] in
    BLOCK-relative content time. Returns a new list of durations (same order,
    same sum) or None when nothing needed moving — the caller keeps the
    planned stamps byte-identical in that case, so every block whose plan
    already agrees with its audio compiles exactly as it always did.

    Boundaries only ever MOVE, they are never added or removed: the beats are
    the storyboard and this is a stamp correction, not an edit. Each boundary
    between beat i and beat i+1 must sit at or after the last word spoken in
    beat i (plus a little tail) and at or before the first word spoken in
    beat i+1 (minus a little lead). When the two constraints cross — one line
    ends exactly where the next begins, the measured hand-off — the cut lands
    ON the hand-off, which is where a real editor would put it.
    """
    n = len(beats)
    if n == 0 or block_ms <= 0:
        return None
    by_beat = {}
    for l in lines or []:
        bid = l.get("beat_id")
        if bid is None:
            continue
        t0 = max(0, min(int(l["t0_ms"]), block_ms))
        t1 = max(0, min(int(l["t1_ms"]), block_ms))
        if t1 <= 0 or t0 >= block_ms:
            continue                     # bleeds wholly outside this block
        cur = by_beat.setdefault(bid, [t0, t1])
        cur[0] = min(cur[0], t0)
        cur[1] = max(cur[1], t1)
    if not by_beat:
        return None

    bounds = [0]
    for b in beats:
        bounds.append(bounds[-1] + int(b.get("duration_ms") or 0))
    # trust the block over the sum: quantisation leaves them a hair apart
    bounds[-1] = block_ms

    out = list(bounds)
    moved = False
    for i in range(1, n):                # interior boundaries only
        prev_span = by_beat.get(beats[i - 1].get("id"))
        next_span = by_beat.get(beats[i].get("id"))
        lo = out[i - 1] + min_shot_ms
        hi = block_ms - min_shot_ms * (n - i)
        want = bounds[i]
        if prev_span:
            lo = max(lo, prev_span[1] + tail_ms)
        if next_span:
            hi = min(hi, next_span[0] - lead_ms)
        if lo > hi:
            # The margins do not fit — a measured hand-off, or a line longer
            # than its window. Drop the margins and aim for the hand-off
            # itself; clamp keeps the boundary legal even then.
            raw_lo = prev_span[1] if prev_span else out[i - 1] + min_shot_ms
            raw_hi = next_span[0] if next_span else hi + min_shot_ms
            want = (raw_lo + raw_hi) // 2
            lo = out[i - 1] + 1
            hi = block_ms - (n - i)
        new = max(lo, min(hi, want))
        if new != bounds[i]:
            moved = True
        out[i] = new
    if not moved:
        return None
    return [out[i + 1] - out[i] for i in range(n)]


def block_lines(spine_asset_meta, beats, block_t0_ms, block_ms):
    """The spine's placements for ONE block, in block-relative time.

    Matches by `beat_id` when the spine recorded one, and by normalized TEXT
    within the block's window otherwise — the fallback is what makes the
    retime reach a spine built before `beat_id` existed, without re-planning
    the episode. Ambiguity is a miss, not a guess: a text that matches two
    beats matches neither.
    """
    lines = (spine_asset_meta or {}).get("lines") or []
    ids = {b.get("id") for b in beats}

    def norm(t):
        return " ".join(str(t or "").lower().split())

    text_to_beat = {}
    for b in beats:
        for d in (b.get("dialogue") or []):
            k = norm(d.get("line"))
            text_to_beat[k] = None if k in text_to_beat else b.get("id")

    out = []
    for l in lines:
        t0, t1 = int(l.get("t0_ms") or 0), int(l.get("t1_ms") or 0)
        if t1 <= block_t0_ms or t0 >= block_t0_ms + block_ms:
            continue
        bid = l.get("beat_id")
        if bid not in ids:
            bid = text_to_beat.get(norm(l.get("line")))
        if bid is None:
            continue
        out.append({"beat_id": bid, "speaker": l.get("speaker"),
                    "line": l.get("line"),
                    "t0_ms": t0 - block_t0_ms, "t1_ms": t1 - block_t0_ms})
    return out

def ref_slot_offsets(lines, beats, warmup_ms, slots):
    """Measured offsets for REFERENCE-staged line slots, from the spine.

    On the ref path (`dialogue_audio: "ref"`) the placement offset DRIVES the
    render instead of describing a pinned track — and the naive per-shot
    lead-in ladder was measured failing on the one tight block of the first
    A/B: told "beginning about 0.7 seconds into the shot", H3 started the
    line at 1.4s (turbo) and 2.0s (PDD) and ran a 4.5s recording out of a
    6.25s block, smearing or dropping the quoted tail. The spine already
    solved this block's placement (`place_onsets`), so hand its measured
    onset to the slot instead of the ladder's guess.

    Returns {slot_no: {"at_ms": int, "shot_idx": int}} for `kind: "line"`
    slots whose text matches a spine line (the block_lines normalizer;
    ambiguity is a miss). Two clock rules, both load-bearing:
    - shot_idx is derived from the onset against the RETIMED beat durations,
      so the offset and the stamp it is relative to cannot disagree;
    - a line in SHOT 1 gets `warmup_ms` added: shot 1 opens at render t=0 and
      the trim removes the warmup, so a content-relative offset there aims
      the line's head BEFORE the delivered take. Under the lock this offset
      was descriptive and the understatement was harmless; here it places.
    """
    def norm(t):
        return " ".join(str(t or "").lower().split())

    by_text = {}
    for l in (lines or []):
        k = norm(l.get("line"))
        by_text[k] = None if k in by_text else l
    starts, cum = [], 0
    for b in (beats or []):
        starts.append(cum)
        cum += int(b.get("duration_ms") or 0)

    out = {}
    for s in (slots or []):
        if (s or {}).get("kind") != "line":
            continue
        m = by_text.get(norm(s.get("text")))
        if not m:
            continue
        t0 = int(m.get("t0_ms") or 0)
        shot = 1
        for i, st in enumerate(starts):
            if t0 >= st:
                shot = i + 1
        at = t0 - starts[shot - 1]
        if shot == 1:
            at += int(warmup_ms or 0)
        out[s["slot"]] = {"at_ms": max(0, at), "shot_idx": shot}
    return out


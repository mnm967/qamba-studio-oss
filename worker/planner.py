"""Deterministic block planner: pack a storyboard's scenes/beats into 15s
master passes (generation_blocks). The LLM authors scenes and beats; packing
is pure code so it is testable and stable.

Rules:
  - beats are never split (oversized beats are pre-split into `(continued)`
    chunks so a bad LLM beat can't wedge the pipeline)
  - film/series: a block boundary is forced where the scene's environment
    changes — a fresh env-anchored pass beats frame-chaining across a
    location cut; blocks chain (Picture-1 anchor) only within a location
  - music video: pack to the fullest block across scene boundaries, then
    snap the cut back to the nearest musical beat (audio_meta.beats_ms);
    blocks always chain for visual flow
  - no residual block below MIN_CONTENT_MS (re-split earlier when needed)

LONG BLOCKS ARE MEASURABLY BETTER, so packing maximises length rather than
merely tolerating it. Across 283 reviewed takes (`take_reviews` joined to
`generation_blocks`), issues per SECOND of finished footage by block length:

    <7s  0.384   7-10s  0.402   10-13s  0.272   13s+  0.234

and dialogue issues per LINE: 0.60 / 0.45 / 0.26 / 0.26. It is a step at ~11s,
not a gradient — short and mid are indistinguishable and long is ~35% cleaner.
The effect survives controls for line density (matched 3-6 lines/15s: 0.441 vs
0.308) and holds inside single storyboards, so it is not a confound with calm
scenes or with code changing over time. The mechanism is that a render's
overhead is FIXED — 22 warmup frames, an unstable opening, a trim, and a join
the next block has to match — so a 5s block pays all of it on 5s of content.

Packing more beats into one pass does not make dialogue denser: merging
preserves both lines and time, and the measured density is already HIGHER in
short blocks (3.7 lines/15s vs 2.8). H3 follows `[Shot N]` fine — within 10s+
blocks, 3-shot and 4-shot passes beat 1-2 shot passes on issues per second.

Packing is therefore an exact min-cost partition (`_pack`) rather than the
left-to-right greedy this used to be. The greedy was non-monotonic — raising
its floor from 4s to 7s made the episode WORSE (78 -> 79 projected issues),
the signature of a local choice stranding the tail. On AFTERLIGHT E3: greedy
28 blocks / 43% of seconds in 11s+ blocks, DP 22 blocks / 64%.
"""
from h3_timing import MAX_CONTENT_MS, MIN_CONTENT_MS

BEAT_SNAP_WINDOW_MS = 900  # how far back a MV cut may move to land on a beat

# Measured issues per second by block length (see module docstring).
ISSUE_RATE = ((7000, 0.384), (10000, 0.402), (13000, 0.272), (None, 0.234))
# One more render is one more warmup, one more join and ~$0.62 of pod time.
# Expressed in the same units as the rate above; the optimum is flat for
# anything in 0.5..4.0, so this is a plateau rather than a tuned constant.
BLOCK_COST = 1.0
# A block that ENDS on a beat carrying dialogue risks losing the line's tail
# to the trim. This used to be a hard flush; as a cost the packer can pay it
# when the alternative is worse, which is what "she was cut off" needed.
TALKY_BOUNDARY_COST = 0.35


def _talk_ms(beat):
    """Speaking time of a beat's dialogue (words at conversational pace).
    Used to keep a block from ENDING on a dialogue-heavy shot: H3 places a
    line late in its shot often enough that a line whose shot touches the
    block boundary loses its tail to the trim."""
    import re
    total = 0
    for d in (beat.get("dialogue") or []):
        w = len(re.findall(r"[\w'’-]+", str(d.get("line") or "")))
        if w:
            total += int(w / 2.4 * 1000) + 600
    return total


def _flatten(scenes):
    """scenes: ordered [{id, environment_id, beats: [{id, duration_ms, ...}]}]
    -> beat dicts with absolute t0 and scene metadata, oversize beats split."""
    out = []
    t = 0
    for sc in scenes:
        for b in sc["beats"]:
            dur = int(b["duration_ms"])
            n_parts = max(1, -(-dur // MAX_CONTENT_MS))
            # Splitting is a pressure valve for a beat too long to render, and
            # it is only SAFE on a silent one: every part keeps the same
            # beat_id, so each resulting block loads the beat's WHOLE dialogue
            # and is told to speak all of it in a fraction of the time.
            # Measured on STATIC b0 — a 15.1s / 19-word beat became two 7.5s
            # blocks that spoke 13% and 9% of their lines. The planner cannot
            # repair that here (the lines belong to the beat, not to the span),
            # so the ceiling is enforced upstream: llm.py clamps a pinned shot
            # to MAX_CONTENT_MS, which is the only path that ever exceeded it.
            # `split_dialogue` marks the case so a caller can see it happened.
            part = dur // n_parts
            for i in range(n_parts):
                d = part if i < n_parts - 1 else dur - part * (n_parts - 1)
                out.append({
                    "beat_id": b["id"], "scene_id": sc["id"],
                    "environment_id": sc.get("environment_id"),
                    "t0": t, "duration_ms": d,
                    "talk_ms": _talk_ms(b) if n_parts == 1 else 0,
                    "split_part": i if n_parts > 1 else None,
                    "split_dialogue": bool(n_parts > 1 and (b.get("dialogue") or [])),
                })
                t += d
    return out


def _block_cost(ms, closes_on_talk):
    """What one candidate block is expected to cost, in review issues."""
    rate = next(r for lim, r in ISSUE_RATE if lim is None or ms < lim)
    return (ms / 1000.0) * rate + BLOCK_COST + \
        (TALKY_BOUNDARY_COST if closes_on_talk else 0.0)


def _runs(flat, is_mv):
    """Stretches a block may span. A location cut is a hard boundary for
    film/series (a fresh env-anchored pass beats chaining across it); a music
    video is one run, so it packs straight through scene changes."""
    if is_mv:
        return [flat] if flat else []
    out, cur = [], []
    for b in flat:
        if cur and b["environment_id"] != cur[-1]["environment_id"]:
            out.append(cur)
            cur = []
        cur.append(b)
    if cur:
        out.append(cur)
    return out


def _pack_dp(run, forbid_talky_end):
    """Exact min-cost partition of one run into legal blocks -> [(i, j), …],
    or None when the constraints admit none.

    Beats are indivisible (`_flatten` has already split oversized ones), so
    the choice is only where the cuts go, and a run is a handful of beats —
    the exact answer is an O(n^2) DP over prefixes. `best[j]` is the cheapest
    way to cover the first j beats.
    """
    n = len(run)
    whole = sum(b["duration_ms"] for b in run)
    best = [None] * (n + 1)
    best[0] = (0.0, [])
    for j in range(1, n + 1):
        for i in range(j):
            if best[i] is None:
                continue
            ms = sum(b["duration_ms"] for b in run[i:j])
            if ms > MAX_CONTENT_MS:
                continue
            # Undersized blocks are refused outright — except when the whole
            # run is that short, where there is nothing to merge them into.
            if ms < MIN_CONTENT_MS and whole >= MIN_CONTENT_MS:
                continue
            talky_end = run[j - 1].get("talk_ms", 0) > 0 and j < n
            if talky_end and forbid_talky_end:
                continue
            c = best[i][0] + _block_cost(ms, talky_end)
            if best[j] is None or c < best[j][0]:
                best[j] = (c, best[i][1] + [(i, j)])
    return best[n][1] if best[n] is not None else None


def _pack(run):
    """Partition one run, preferring never to END a block on a beat that
    carries dialogue — trims eat late line tails, and "she was cut off
    mid-sentence" was always a talky shot touching a boundary.

    That preference is a HARD constraint first and a cost only if it admits
    no partition at all, which is the common case once several beats in a row
    speak: forbidding every cut after a talky beat would leave a long run with
    nowhere legal to cut. Solving it as a constraint rather than greedily is
    the difference — the old planner could only apply the rule when the block
    was already past the floor, so it flushed early and produced the short
    blocks the measurements above indict.
    """
    for forbid in (True, False):
        spans = _pack_dp(run, forbid_talky_end=forbid)
        if spans is not None:
            return spans
    # No legal partition even unconstrained (a run whose beats cannot satisfy
    # the floor any way it is cut) — one block per beat rather than wedging
    # the pipeline; the rebalance pass below picks up the pieces.
    return [(i, i + 1) for i in range(len(run))]


def _snap_to_music_beat(cut_ms, beats_ms, lo_ms):
    """Move a cut earlier onto the nearest musical beat within the window,
    never below lo_ms (which would starve the block)."""
    if not beats_ms:
        return cut_ms
    best = None
    for bm in beats_ms:
        if lo_ms <= bm <= cut_ms and cut_ms - bm <= BEAT_SNAP_WINDOW_MS:
            if best is None or bm > best:
                best = bm
    return best if best is not None else cut_ms


def plan_blocks(scenes, *, medium, beats_ms=None):
    """-> ordered block dicts:
    {idx, scene_ids, beat_ids, t_start_ms, t_end_ms, chain: bool}
    `chain` means: use the previous block's last frame as Picture 1."""
    flat = _flatten(scenes)
    if not flat:
        return []
    is_mv = medium == "music_video"

    blocks = []
    for run in _runs(flat, is_mv):
        for i, j in _pack(run):
            seg = run[i:j]
            blocks.append({
                "scene_ids": list(dict.fromkeys(b["scene_id"] for b in seg)),
                "beat_ids": list(dict.fromkeys(b["beat_id"] for b in seg)),
                "t_start_ms": seg[0]["t0"],
                "t_end_ms": seg[-1]["t0"] + seg[-1]["duration_ms"],
                "env": seg[-1]["environment_id"],
                "start_env": seg[0]["environment_id"],
            })

    # MV: snap block boundaries onto the music grid by trading beats between
    # neighbors is overkill — beats themselves came from the grid; instead we
    # only *report* the snapped boundary when the following beat can absorb
    # the shift. Cheap and safe: adjust t_end back onto a musical beat when
    # the gap lands inside the NEXT block's first beat.
    if is_mv and beats_ms:
        for i in range(len(blocks) - 1):
            b, nxt = blocks[i], blocks[i + 1]
            lo = b["t_start_ms"] + MIN_CONTENT_MS
            snapped = _snap_to_music_beat(b["t_end_ms"], beats_ms, lo)
            shift = b["t_end_ms"] - snapped
            if shift and nxt["t_end_ms"] - snapped <= MAX_CONTENT_MS:
                b["t_end_ms"] = snapped
                nxt["t_start_ms"] = snapped

    # Backstop: `_pack` already refuses undersized blocks, so this only fires
    # on its one-block-per-beat fallback (a run no legal partition covers).
    # Merge into the previous when the sum fits and the location matches.
    i = 0
    while i < len(blocks):
        b = blocks[i]
        if b["t_end_ms"] - b["t_start_ms"] < MIN_CONTENT_MS and i > 0:
            prev = blocks[i - 1]
            if b["t_end_ms"] - prev["t_start_ms"] <= MAX_CONTENT_MS and \
                    (is_mv or prev["env"] == b.get("start_env", b["env"])):
                prev["t_end_ms"] = b["t_end_ms"]
                prev["scene_ids"] = list(dict.fromkeys(prev["scene_ids"] + b["scene_ids"]))
                prev["beat_ids"] = list(dict.fromkeys(prev["beat_ids"] + b["beat_ids"]))
                prev["env"] = b["env"]
                blocks.pop(i)
                continue
        i += 1

    out = []
    for i, b in enumerate(blocks):
        prev = blocks[i - 1] if i else None
        chain = bool(prev) and (is_mv or prev["env"] == b.get("start_env", b["env"]))
        out.append({
            "idx": i,
            "scene_ids": b["scene_ids"],
            "beat_ids": b["beat_ids"],
            "t_start_ms": b["t_start_ms"],
            "t_end_ms": b["t_end_ms"],
            "chain": chain,
        })
    return out

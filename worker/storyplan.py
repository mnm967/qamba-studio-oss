"""The staged studio pipeline: writer → story editor → cinematographer.

plan_storyboard used to ask one completion to be screenwriter, director,
cinematographer, scheduler and JSON generator at once, and the output showed
it: one 9-second beat per scene, every camera "a medium shot; the camera
pushes in with small amplitude at slow speed". A scene is a container — the
missing middle was the decomposition into beats and shots, and no prompt nudge
fixes a stage that does not exist.

Each stage here owns ONE artifact and hands it to the next through an explicit
contract:

  writer          story only: world, characters (all of them, with voices),
                  scenes with purpose/emotion, narrative beats with the
                  dialogue attached to beats. No cameras anywhere.
  story editor    dramatic critique of the writer's artifact — conflict per
                  scene, repetition, sag, payoff — returning a REVISED story,
                  never new lore.
  cinematographer coverage: each narrative beat becomes 1-N shots with real
                  camera grammar and each dialogue line assigned to the shot
                  it is spoken in. No new story, no new lines.

Between stages sit deterministic validators (pure functions, unit-tested):
shot-count floors per scene, dialogue-duration floors so lines are never cut
off mid-sentence, camera-monoculture detection, cast completeness (a speaker
who is not in the character list gets a sheet or gets hallucinated later),
and duration fitting that scales slack, never dialogue time.

The hierarchy lands in the existing tables: scenes stay scenes; a `beats`
table row is a SHOT (it always compiled to `[Shot N]`); the narrative beat a
shot serves rides in `beats.meta.beat = {idx, label}` and the scene keeps the
writer's beat list in `scenes.meta.beats`. Scene → beat → shot → generation
block, with no schema migration.

This module is pure logic over dicts: the LLM call is injected (`ask`), the
DB writes stay in llm.plan_storyboard. Everything here is testable off-pod.
"""
import json
import math
import re

# ---------------------------------------------------------------- timing ----
WORDS_PER_SEC = 2.0          # H3's generated speaking pace (pauses ride inside lines)
LINE_PAD_MS = 1200           # breath before/after a line inside its shot —
                             # raised twice (600→900→1200) after live takes
                             # kept running lines out of their shots
SHOT_MIN_MS = 1500
SHOT_MAX_MS = 12000          # a longer hold packs fine but reads as neglect
SCENE_ONER_MS = 7000         # scenes up to this may stay a single shot

SIZES = ("extreme wide", "wide", "full", "medium wide", "medium",
         "medium close-up", "close-up", "extreme close-up", "insert",
         "over-the-shoulder", "two-shot", "POV")

# The official H3 motion vocabulary — the cinematographer writes camera prose
# out of these, and the validator flags anything that collapses into one habit.
MOTIONS = ("Zoom In", "Zoom Out", "Push In", "Pull Out", "Pan Left",
           "Pan Right", "Truck Left", "Truck Right", "Tilt Up", "Tilt Down",
           "Pedestal Up", "Pedestal Down", "Arc Shot", "Tracking Shot",
           "Static Shot", "Shake Slightly", "Shake Strongly", "POV",
           "Roll Clockwise", "Roll Counterclockwise")


def words(text):
    return len(re.findall(r"[\w'’-]+", str(text or "")))


def dialogue_ms(lines):
    """Speaking time for a shot's assigned lines. This is the floor a shot's
    duration must clear — a 12-word line in a 2-second shot is exactly the
    'dialogue plays at the end and gets cut off' bug."""
    total = 0
    for d in lines or []:
        w = words(d.get("line"))
        if w:
            total += int(w / WORDS_PER_SEC * 1000) + LINE_PAD_MS
    return total


def shot_floor_ms(shot):
    # A breath shot has no dialogue, so the generic floor would let the fitter
    # squeeze it to SHOT_MIN_MS and undo the pause it exists to create.
    if ((shot.get("meta") or {}).get("breath")):
        return BREATH_FLOOR_MS
    return max(SHOT_MIN_MS, dialogue_ms(shot.get("dialogue")))


def fit_shot_durations(scenes, target_ms):
    """Scale shot durations onto the target length without ever squeezing a
    shot below its dialogue floor. LLM arithmetic is unreliable; floors are
    not negotiable; everything above a floor is slack that scales.

    scenes: [{..., "shots": [{duration_ms, dialogue, ...}]}] — mutated in place.
    Returns the fitted total (may exceed target when floors alone do)."""
    shots = [sh for sc in scenes for sh in sc["shots"]]
    if not shots or not target_ms:
        return 0
    floors = [shot_floor_ms(sh) for sh in shots]
    durs = [max(int(sh.get("duration_ms") or 0), f) for sh, f in zip(shots, floors)]
    floor_total = sum(floors)
    if target_ms <= floor_total:
        fitted = list(floors)                       # floors win over the target
    else:
        slack = [d - f for d, f in zip(durs, floors)]
        slack_total = sum(slack) or 1
        budget = target_ms - floor_total
        fitted = [f + int(s * budget / slack_total) for f, s in zip(floors, slack)]
    for sh, f, ms in zip(shots, floors, fitted):
        ms = min(SHOT_MAX_MS, max(f, int(round(ms / 250) * 250)))
        sh["duration_ms"] = max(SHOT_MIN_MS, ms)
    for sc in scenes:
        sc["duration_ms"] = sum(sh["duration_ms"] for sh in sc["shots"])
    return sum(sh["duration_ms"] for sh in shots)


# ─────────────────────────────────── revising one block ──────────────────────
# A retake's brief has to be able to change the SHOT, and until this existed it
# could not. `handle_master_pass` appended it to the finished compiled
# description as "Director's adjustment for this take:" and built everything
# else from the same unchanged beats — so a brief asking for different blocking,
# a different camera or different DIALOGUE produced the same shot with a
# sentence stapled to the end of it. Dialogue was guaranteed not to change: the
# lines are recorded at plan time, staged as reference audio and bound
# "precisely lip-synced to <Audio N>", so the recording still said the old words
# however the prose was rewritten.
#
# Invariant #6 is untouched and is the reason this works at all: the model
# rewrites the STRUCTURED beats, and h3_prompt/ltx_prompt compile the envelope
# from them deterministically. That is the same contract `update_beat` follows
# from the director chat — this is the batched, whole-block form of it.
REVISE_CONTRACT = """You are revising ONE already-planned sequence of shots (a
render "block") because the director asked for a change. You are given the
shots as structured data and the director's note in plain language.

Rewrite ONLY what the note asks for, and rewrite it PROPERLY — not by appending
a sentence. If the note asks for a different line, the line is replaced. If it
asks for a slower push, the camera prose is rewritten. If it asks for someone to
leave the frame, they come out of `cast` AND out of the action.

Return JSON and nothing else:
{"shots": [{"n": 1, "action": "...", "camera": "...", "dialogue": [
   {"speaker": "Name", "line": "...", "delivery": "..."}], "cast": ["Name"],
   "sfx": "..."}],
 "drop_shots": [2, 3],
 "summary": "one sentence naming what you changed"}

Rules:
- `n` is the shot number as given. Include a shot ONLY if it changes, and
  inside it only the keys that change. Omitting a key keeps it.
- `action` is concrete physical action, present tense, one shot's worth. No
  camera language in it.
- `camera` is shot size + motion type + amplitude + speed, in prose.
- `dialogue` REPLACES that shot's lines. `[]` means the shot becomes silent.
  Speakers must be characters already in this block unless the note introduces
  one. Keep lines speakable in the time the shot has. A line may carry
  `"offscreen": true` — it plays as voice-over while the camera is elsewhere,
  and its speaker stays out of that shot's `cast` and `action`. A line
  returned without the key keeps the flag it had.
- `cast` is who is VISIBLE in the shot, by name. This decides whose reference
  sheets are staged, so removing someone from the action alone is not enough —
  the render follows the pictures.
- `drop_shots` is optional and REMOVES shots, by the numbers you were given.
  It is how a note asking for fewer cuts is answered: "one continuous shot, no
  cuts" is shot 1 rewritten to carry the whole action, plus
  `"drop_shots": [2, 3]`. The block's total length never changes - the shots
  that remain absorb the time - so use it whenever the note asks for a merge
  rather than describing one continuous move across three shots that still
  cut. Move any dialogue you are keeping into a surviving shot first: a
  dropped shot's lines go with it. At least one shot must survive, and you
  cannot ADD shots.
- `staged_references` lists the pictures this block will actually be rendered
  with. It is context, not an instruction. Use it to describe people the way
  their own reference shows them - never write an outfit or a prop the staged
  sheet does not show - and to see what the render has to work with. The
  note still decides who is in the shot.
- Never write the compiled prompt format, timestamps, `[Shot N]` headers or
  `<Subject N>` markers. Those are generated from these fields.
- Change nothing the note did not ask for."""

# What a reviser may write. Everything else on a beat — its id, its scene, the
# panel it drew, the narrative beat it serves — belongs to the plan.
REVISE_TEXT_KEYS = ("action", "camera", "sfx")


def _absorb_residual(shots, target_ms):
    """Make the shots sum to EXACTLY `target_ms`, in place.

    `fit_shot_durations` rounds each shot to 250ms and clamps it to
    SHOT_MIN/MAX, so its total lands near the target rather than on it. That is
    right for the planner — the packer reads the fitted durations and forms
    blocks out of them, so the total simply becomes what it becomes — and wrong
    here, where the block's window and frame count are already fixed. Measured
    on the first test that asked: a 12.0s block came back as 12.75s of beats,
    which stamps `[Shot N] At HH:MM:SS.mmm` timestamps running 750ms past the
    end of a render that is 12.0s long.

    Time is only ever taken from slack ABOVE a shot's floor, so absorbing a
    residual can never squeeze a line below speaking time. When there is no
    slack left it gives up rather than looping — `revise_beats` has already
    warned that the lines do not fit.
    """
    floors = [shot_floor_ms(sh) for sh in shots]
    for _ in range(len(shots) + 1):
        delta = target_ms - sum(sh["duration_ms"] for sh in shots)
        if delta == 0:
            return
        if delta > 0:
            # Spare time goes to the longest shot: it is the one whose length
            # is a held moment rather than a spoken line.
            shots[max(range(len(shots)),
                      key=lambda j: shots[j]["duration_ms"])]["duration_ms"] += delta
            return
        j = max(range(len(shots)), key=lambda k: shots[k]["duration_ms"] - floors[k])
        room = shots[j]["duration_ms"] - floors[j]
        if room <= 0:
            return
        shots[j]["duration_ms"] -= min(-delta, room)


def _norm_line(s):
    """A spoken line, comparable across a rewrite that only re-cased or
    re-spaced it."""
    return " ".join(str(s or "").lower().split())


def dropped_beats(beats, revision):
    """Which of this block's beats a revision REMOVES -> ([beat_id], warnings).

    A BLOCK'S WINDOW IS FIXED AND ITS SUBDIVISION IS NOT, which is the whole
    reason this is safe to allow. The block is a slot in the episode's
    timeline; how many shots fill that slot is the revision's business, and
    dropping one redistributes its time across the survivors (`revise_beats`
    refits to `block_ms`), so the block, its scene and every block after it
    come out exactly the length they already were.

    It exists because "one continuous shot, no cuts" was UNSAYABLE. The
    reviser could rewrite each shot and never merge two, so a three-shot block
    asked for a oner came back as three shots whose prose each described one
    continuous move - measured on Rei EP04 b45, twice: both runs reported
    changing exactly one beat, and the compiled envelope still cut at
    00:08.655 and 00:10.155. Fixing it meant opening the scene editor and
    deleting beats by hand, which is the thing a retake brief is for.

    Deliberately NOT the inverse: a revision cannot ADD shots. That would mean
    inventing rows, indexes and panel provenance in the middle of a retake, and
    every request measured so far asks for fewer cuts rather than more. An
    out-of-range shot number is already dropped with a warning.
    """
    raw = (revision or {}).get("drop_shots")
    if not isinstance(raw, list) or not raw:
        return [], []
    warnings, want = [], []
    for v in raw:
        try:
            n = int(v)
        except (TypeError, ValueError):
            warnings.append(f"drop_shots carried {v!r}, which is not a shot number - ignored")
            continue
        if not 1 <= n <= len(beats):
            warnings.append(f"shot {n} is not in this block ({len(beats)} shots) - not dropped")
            continue
        if n not in want:
            want.append(n)
    if not want:
        return [], warnings
    if len(want) >= len(beats):
        # The floor is one, not zero: a block with no beats compiles to
        # nothing (`compile_block` raises "block has no beats") and a scene
        # can be left with none at all. Refusing the whole drop rather than
        # keeping an arbitrary shot, because which one survives is a
        # directing decision and guessing it silently is worse than a warning.
        warnings.append(
            f"the revision asked to drop all {len(beats)} shots; a block must keep at "
            f"least one, so none were dropped - say which shot the merged action "
            f"belongs in")
        return [], warnings

    kept = [n for n in range(1, len(beats) + 1) if n not in want]
    by_n = {}
    for e in (revision or {}).get("shots") or []:
        if not isinstance(e, dict):
            continue
        try:
            by_n[int(e.get("n"))] = e
        except (TypeError, ValueError):
            pass

    def _lines(n):
        """What shot `n` says AFTER this revision - the revision where it
        rewrote the shot's dialogue, the beat where it left it alone."""
        e = by_n.get(n) or {}
        src = (e["dialogue"] if isinstance(e.get("dialogue"), list)
               else (beats[n - 1].get("dialogue") or []))
        return [_norm_line(d.get("line")) for d in src
                if isinstance(d, dict) and str(d.get("line") or "").strip()]

    survives = {l for n in kept for l in _lines(n)}
    for n in sorted(want):
        for l in _lines(n):
            if l not in survives:
                # Not refused - a note may well mean "cut that line". Said out
                # loud because the alternative is discovering it in the take,
                # and because the lines are recorded at plan time: a line
                # dropped here is a recording nothing will ever place.
                warnings.append(
                    f'shot {n} was dropped and its line "{l[:48]}" is in no surviving '
                    f"shot - it is gone from this block")
        if ((beats[n - 1].get("meta") or {}).get("start_frame_asset_id")):
            # `ref_plan_for` reads the opening frame off the block's FIRST
            # beat, so dropping the shot that carries one silently changes
            # what the segment opens on - and on an i2v or flf block it is
            # fatal at render time, several minutes in.
            warnings.append(
                f"shot {n} carried this block's opening frame - dropping it means the "
                f"block opens on whatever the new first shot supplies")

    return [beats[n - 1]["id"] for n in sorted(want)], warnings


def revise_beats(beats, revision, block_ms, *, dropped=()):
    """Apply a reviser's JSON to a block's beats. -> (patches, warnings)

    `beats` are the block's rows, in order. `patches` is [(beat_id, patch)] for
    the beats that actually change; `warnings` are things the director should
    read BEFORE the render is spent rather than discover in the take.

    Durations are refitted across the block afterwards, never taken from the
    model: the beats of a block must keep summing to the block's own window
    (the compiler stamps `[Shot N] At HH:MM:SS.mmm` from them and the render is
    exactly that long), and a longer line needs its shot to grow at the expense
    of its neighbours' slack — which is arithmetic, not writing. `dialogue_ms`
    is the same floor the planner uses, so a line can never be squeezed below
    speaking time here either.
    """
    dropped = {str(x) for x in (dropped or ())}
    patches = {b["id"]: {} for b in beats if b["id"] not in dropped}
    warnings = []
    seen = set()
    for entry in (revision or {}).get("shots") or []:
        if not isinstance(entry, dict):
            continue
        try:
            n = int(entry.get("n"))
        except (TypeError, ValueError):
            warnings.append("a revised shot arrived with no shot number and was dropped")
            continue
        if not 1 <= n <= len(beats):
            warnings.append(f"shot {n} is not in this block ({len(beats)} shots) — dropped")
            continue
        if n in seen:
            warnings.append(f"shot {n} was revised twice — the later one wins")
        seen.add(n)
        beat = beats[n - 1]
        if beat["id"] in dropped:
            # Revised AND dropped. Legitimate on the model's part (it may have
            # rewritten shot 2 before deciding to merge it away), but the
            # rewrite has nowhere to land, so say so rather than lose it in
            # silence.
            warnings.append(f"shot {n} was both revised and dropped - its rewrite is discarded")
            continue
        patch = patches[beat["id"]]
        for k in REVISE_TEXT_KEYS:
            if k not in entry:
                continue
            v = str(entry[k] or "").strip()
            # An empty string is the model dropping a field, not erasing a
            # shot. Erasing `action` leaves the compiler nothing to describe.
            if not v:
                warnings.append(f"shot {n}: empty {k} ignored")
                continue
            if v != (beat.get(k) or ""):
                patch[k] = v
        if isinstance(entry.get("cast"), list):
            cast = [str(x).strip() for x in entry["cast"] if str(x).strip()]
            meta = dict(beat.get("meta") or {})
            if cast != list(meta.get("cast") or []):
                meta["cast"] = cast
                patch["meta"] = meta
        if isinstance(entry.get("dialogue"), list):
            old = beat.get("dialogue") or []
            lines = []
            for i, d in enumerate(entry["dialogue"]):
                if not isinstance(d, dict):
                    continue
                line = str(d.get("line") or "").strip()
                if not line:
                    continue
                # A missing speaker keeps whoever spoke in that position, so a
                # model that rewrites the words and forgets the attribution
                # does not silently reassign the line to nobody.
                speaker = str(d.get("speaker") or "").strip() \
                    or str((old[i] if i < len(old) else {}).get("speaker") or "").strip()
                if not speaker:
                    warnings.append(f"shot {n}: a line with no speaker was dropped")
                    continue
                # The V.O. flag: the model's explicit value wins (it may set
                # OR clear it), else the line at this position keeps its own —
                # the contract says an omitted key keeps what it had, and a
                # rebuilt whitelist dict would otherwise strip the DP's
                # cutaway on every revision, silently.
                off = (coerce_offscreen(d.get("offscreen")) if "offscreen" in d
                       else bool((old[i] if i < len(old) else {}).get("offscreen")))
                lines.append({"speaker": speaker, "line": line,
                              **({"delivery": str(d["delivery"]).strip()}
                                 if str(d.get("delivery") or "").strip() else {}),
                              **({"offscreen": True} if off else {})})
            if [(l["speaker"], l["line"], bool(l.get("offscreen"))) for l in lines] != \
               [(str(d.get("speaker") or ""), str(d.get("line") or ""),
                 bool(d.get("offscreen"))) for d in old]:
                patch["dialogue"] = lines

    # ---- refit the block's own window ---------------------------------------
    # Over the SURVIVORS. A dropped shot's time is not lost, it is absorbed:
    # the block is a fixed slot in the episode's timeline, so merging three
    # shots into one has to leave that one holding all three shots' worth.
    live = [b for b in beats if b["id"] not in dropped]
    shots = [{"duration_ms": b.get("duration_ms") or 0,
              "dialogue": patches[b["id"]].get("dialogue", b.get("dialogue") or []),
              "meta": patches[b["id"]].get("meta", b.get("meta") or {})}
             for b in live]
    if block_ms and shots:
        floor_total = sum(shot_floor_ms(sh) for sh in shots)
        fit_shot_durations([{"shots": shots}], block_ms)
        _absorb_residual(shots, block_ms)
        if floor_total > block_ms:
            warnings.append(
                f"the revised lines need about {floor_total / 1000:.1f}s of speaking time "
                f"and this block is {block_ms / 1000:.1f}s — something will be cut off. "
                f"Shorten a line, or split the block.")
        for b, sh in zip(live, shots):
            if sh["duration_ms"] != (b.get("duration_ms") or 0):
                patches[b["id"]]["duration_ms"] = sh["duration_ms"]

    return [(bid, p) for bid, p in patches.items() if p], warnings


BREATH_MS = 2250             # a held, wordless beat before a location cut
BREATH_FLOOR_MS = 1750       # …and the least it may be squeezed to


def add_breath_shot(scene, shots):
    """Append a wordless held shot to the end of a scene.

    Scenes were cutting straight from a spoken line into the next location,
    which reads as rushed and gives the audience nowhere to land. A beat of
    quiet before the change is the fix, and it is deterministic — asking the
    writer for "room to breathe" produces adjectives, not shots.

    It also pays for itself in the packer: the hard rule is that a block may
    never END on a beat carrying dialogue, and a scene whose last beat speaks
    forces a cut earlier than the location boundary. A silent tail gives every
    scene a legal place to end, which is why this runs BEFORE duration fitting
    rather than being bolted on at compile time.

    No-op when the scene already ends quiet — the point is a pause, not a
    second one.
    """
    if not shots:
        return shots
    last = shots[-1]
    if not (last.get("dialogue") or []):
        return shots
    where = (last.get("positions") or {})
    shots.append({
        "camera": "the camera holds a static shot on the space just left",
        "action": "A held, wordless beat: no one speaks and nothing new enters "
                  "the frame; only ambient motion continues.",
        "dialogue": [],
        "duration_ms": BREATH_MS,
        "positions": where,
        "cast": list(last.get("cast") or []),
        "beat": last.get("beat"),
        "meta": {**(last.get("meta") or {}), "breath": True},
    })
    return shots


def min_shots(scene_dur_ms, scene_type=None):
    """How many shots a scene of this length owes its audience. Dialogue and
    quiet scenes cut around 1/5s; action cuts around 1/3.5s. A short scene may
    be a oner."""
    if scene_dur_ms <= SCENE_ONER_MS:
        return 1
    per = 3500 if scene_type == "action" else 5500
    return max(2, min(10, math.ceil(scene_dur_ms / per)))


# ------------------------------------------------------------- validators ----
_CAM_NORM = re.compile(r"[^a-z ]+")


def _cam_key(camera):
    return _CAM_NORM.sub("", str(camera or "").lower()).strip()


def camera_issues(shots):
    """Monoculture detection. Returns a list of human-readable problems, empty
    when the coverage varies like coverage should."""
    keys = [_cam_key(s.get("camera")) for s in shots if s.get("camera")]
    issues = []
    for a, b in zip(keys, keys[1:]):
        if a and a == b:
            issues.append("two consecutive shots share the identical camera setup")
            break
    if len(keys) >= 4:
        from collections import Counter
        top, n = Counter(keys).most_common(1)[0]
        if n / len(keys) > 0.34:
            issues.append(f'"{top[:60]}" is {n} of {len(keys)} shots — one setup is '
                          f"carrying the whole piece")
    if len(keys) >= 4:
        sized = sum(1 for k in keys if any(s in k for s in
                                           ("wide", "close", "medium", "insert",
                                            "shoulder", "two shot", "pov", "full")))
        if sized / len(keys) < 0.6:
            issues.append("most shots never state a shot size — say wide/medium/"
                          "close-up etc. explicitly")
    # ANGLE monoculture — the axis the checks above cannot see. A scene can
    # vary its sizes perfectly and still sit at eye level for every setup,
    # which reads as television coverage rather than cinematography; and the
    # renderers OBEY stated angles now (measured: low, overhead, OTS and dutch
    # all land), so an angle the plan never asks for is simply never shot.
    # Threshold is deliberately lax — one non-eye-level setup anywhere in a
    # 5+ shot scene satisfies it; the failure being caught is ZERO.
    if len(keys) >= 5:
        angled = sum(1 for k in keys if any(a in k for a in
                                            ("low angle", "lowangle", "high angle",
                                             "highangle", "overhead", "aerial",
                                             "dutch", "canted", "shoulder",
                                             "birds eye", "birdseye", "worms")))
        if angled == 0:
            issues.append("every shot sits at flat eye level — put at least one "
                          "setup at a low or high angle, overhead, or "
                          "over-the-shoulder where the drama supports it")
    return issues


def scene_shot_issues(scene, shots):
    """Everything wrong with one scene's coverage, as re-ask instructions."""
    issues = []
    # The scene's PLANNED duration is the basis, not just what the shots sum
    # to: a cinematographer that answered one 6s shot for a 20s scene must be
    # told to decompose, not congratulated for the short sum — global fitting
    # will stretch whatever shots exist to fill the scene's real length.
    dur = max(sum(int(s.get("duration_ms") or 0) for s in shots),
              int(scene.get("duration_ms") or 0))
    need = min_shots(dur, scene.get("type"))
    if len(shots) < need:
        issues.append(f"{len(shots)} shot(s) for {dur / 1000:.0f}s — decompose into at "
                      f"least {need} shots (coverage: establish, mediums, close-ups, "
                      f"inserts, reactions)")
    for s in shots:
        need_ms = dialogue_ms(s.get("dialogue"))
        if need_ms and int(s.get("duration_ms") or 0) < need_ms:
            issues.append(f'a shot holds {words_of_lines(s)} words of dialogue in '
                          f'{int(s.get("duration_ms") or 0)}ms — the line needs '
                          f"~{need_ms}ms to be spoken")
            break
    is_action = (scene.get("type") or "").lower() == "action"
    if is_action:
        # Position discipline: an action shot with 2+ people and no stated
        # positions is the geography drift the sequence review keeps flagging.
        bare = sum(1 for s in shots
                   if len(s.get("cast") or []) >= 2 and not s.get("positions"))
        if bare:
            issues.append(f"{bare} multi-character shot(s) have no `positions` — "
                          f"name where each character stands against the scene's "
                          f"anchor features in every one")
        # Tempo discipline: a fight shot list dominated by static holds plays
        # as slow sparring however violent the prose is.
        keys = [_cam_key(s.get("camera")) for s in shots if s.get("camera")]
        static = sum(1 for k in keys if "static" in k)
        if len(keys) >= 3 and static / len(keys) > 0.5:
            issues.append(f"{static} of {len(keys)} action shots hold a static "
                          f"camera — the camera participates in a fight: tracking "
                          f"at fast speed, fast push-ins on impacts, shake at the "
                          f"moment of contact; keep statics for the geography wide")
        slow = [s for s in shots
                if int(s.get("duration_ms") or 0) > 5000 and not s.get("dialogue")]
        if len(shots) >= 3 and len(slow) > len(shots) / 2:
            issues.append("most action shots run past 5s — exchanges cut at "
                          "2000-3500ms; long holds are for aftermath only")
    issues.extend(camera_issues(shots))
    return issues


def words_of_lines(shot):
    return sum(words(d.get("line")) for d in shot.get("dialogue") or [])


def missing_cast(story):
    """Names that speak or appear on screen but are not in characters[] —
    exactly the people who render with a different face every block."""
    known = {c["name"].strip().lower() for c in story.get("characters") or []}
    missing = []

    def note(name):
        n = (name or "").strip()
        if n and n.lower() not in known and n.lower() not in (m.lower() for m in missing):
            missing.append(n)

    for sc in story.get("scenes") or []:
        for n in sc.get("cast") or []:
            note(n)
        for b in sc.get("beats") or []:
            for d in b.get("dialogue") or []:
                note(d.get("speaker"))
    return missing


def missing_locations(story):
    """Scenes whose environment is unset or names nothing in environments[] —
    exactly the scenes that bind to no bible entry downstream, render every
    panel and block with NO location reference, and so re-invent the place
    shot to shot. The plate rotation that varies the camera has nothing to
    stand on there. (Rei E3's ASTRONAUT-CAPTURE shipped this way: a flashback
    whose capture space lived only in the vfx prose.)"""
    known = {(e.get("name") or "").strip().lower()
             for e in story.get("environments") or []}
    out = []
    for sc in story.get("scenes") or []:
        env = (sc.get("environment") or "").strip()
        if not env or env.lower() not in known:
            out.append({"slug": sc.get("slug"), "environment": env or None})
    return out


def fallback_location(scene):
    """A location derived from the scene's own material, for a scene the
    re-ask still left unlocated. Mirrors the extra-stub fallback in cast
    completeness: a mechanical binding beats a scene with no location control.

    If the scene NAMED a place (just not one in environments[]), that name is
    kept — the writer meant something by it, and inventing a second name for
    the same place is how bibles fill with duplicates. The identity line takes
    the richest prose the scene carries about the place."""
    want = (scene.get("environment") or "").strip()
    slug = str(scene.get("slug") or "scene").strip()
    name = want or (re.sub(r"[-_]+", " ", slug).strip().title() or "Unnamed Setting")
    ident = " ".join(str(
        (scene.get("vfx_ref") or {}).get("prompt")
        or (scene.get("blocking") or {}).get("map")
        or scene.get("purpose") or "").split())
    return {"name": name[:80], "summary": scene.get("purpose"),
            "identity_line": ident[:400] or f"The setting of {name}."}


# ------------------------------------------------------- dialogue assignment --
def _line_key(line):
    return re.sub(r"\W+", " ", str(line or "").lower()).strip()[:48]


def coerce_offscreen(v):
    """The DP's V.O. flag as a real bool. Models emit "true"/"false" STRINGS
    often enough that a bare truthiness test reads "false" as marked — the
    quiet inversion, on the field whose whole job is a placement decision."""
    if isinstance(v, str):
        return v.strip().lower() in ("true", "yes", "1")
    return bool(v)


def reconcile_dialogue(scene, shots):
    """The writer owns the words; the cinematographer only places them.

    Every beat line must appear in exactly one shot: a line the shot list
    dropped is restored (onto the last shot serving its beat), a line the shot
    list invented is cut, and duplicates keep their first placement."""
    beat_lines = []                              # (beat_idx, line_dict)
    for bi, b in enumerate(scene.get("beats") or []):
        for d in b.get("dialogue") or []:
            if d.get("line"):
                beat_lines.append((bi, d))
    placed = set()
    for sh in shots:
        kept = []
        for d in sh.get("dialogue") or []:
            k = _line_key(d.get("line"))
            hit = next(((bi, bd) for bi, bd in beat_lines
                        if _line_key(bd.get("line")) == k), None)
            if hit is None or k in placed:
                continue                          # invented or duplicated line
            placed.add(k)
            # `delivery` and `offscreen` are the cinematographer's — the read
            # and the placement — so they ride the shot's own entry onto the
            # beat's dict, which cannot carry either.
            kept.append({**hit[1],
                         **({"delivery": d["delivery"]} if d.get("delivery") else {}),
                         **({"offscreen": True} if d.get("offscreen") else {})})
        sh["dialogue"] = kept
    for bi, d in beat_lines:
        if _line_key(d.get("line")) in placed:
            continue
        target = next((sh for sh in reversed(shots)
                       if _beat_ref_idx(sh, scene) == bi), shots[-1] if shots else None)
        if target is not None:
            target.setdefault("dialogue", []).append(dict(d))
            placed.add(_line_key(d.get("line")))
    return shots


def _beat_ref_idx(shot, scene):
    """Which narrative beat a shot says it serves — by index or label."""
    ref = shot.get("beat")
    beats = scene.get("beats") or []
    if isinstance(ref, int):
        return ref if 0 <= ref < len(beats) else None
    label = str(ref or "").strip().lower()
    for i, b in enumerate(beats):
        if str(b.get("label") or "").strip().lower() == label:
            return i
    m = re.match(r"^b?(\d+)$", label)
    if m:
        i = int(m.group(1)) - 1
        return i if 0 <= i < len(beats) else None
    return None


def attach_beats(scene, shots):
    """Stamp meta-beat linkage; shots with no usable ref inherit the previous
    shot's beat (coverage of the same moment) or beat 0."""
    cur = 0
    for sh in shots:
        idx = _beat_ref_idx(sh, scene)
        if idx is not None:
            cur = idx
        beats = scene.get("beats") or []
        sh["beat_idx"] = cur if cur < len(beats) else max(0, len(beats) - 1)
        sh["beat_label"] = (beats[sh["beat_idx"]].get("label")
                            if beats else None)
    return shots


# ------------------------------------------------------ deterministic split --
_SIZE_LADDER = {
    "extreme wide": "medium", "wide": "medium close-up", "full": "medium",
    "medium wide": "close-up", "medium": "close-up",
    "medium close-up": "close-up", "close-up": "extreme close-up",
}


def split_shot(shot):
    """Last-resort decomposition when the model would not: same moment, two
    angles. The first half keeps the setup; the second moves one size closer
    (or back out to a wide from a close-up) and holds."""
    cam = str(shot.get("camera") or "a medium shot")
    size = next((s for s in _SIZE_LADDER if s in cam.lower()), "medium")
    closer = _SIZE_LADDER.get(size, "close-up")
    if "close" in size:
        second_cam = "a wide shot; the camera holds a static shot as the moment settles"
    else:
        second_cam = f"a {closer}; the camera holds a static shot on the reaction"
    dur = int(shot.get("duration_ms") or 4000)
    action = str(shot.get("action") or "")
    parts = re.split(r"(?<=[.!?])\s+", action, maxsplit=1)
    first_action = parts[0] if parts else action
    second_action = (parts[1] if len(parts) > 1 else
                     f"The moment lands; the reaction is held. {first_action}"[:200])
    a = {**shot, "duration_ms": dur // 2, "action": first_action}
    b = {**shot, "duration_ms": dur - dur // 2, "camera": second_cam,
         "action": second_action, "dialogue": []}
    # dialogue stays with the first half unless it does not fit there
    if dialogue_ms(shot.get("dialogue")) > a["duration_ms"]:
        a["duration_ms"], b["duration_ms"] = b["duration_ms"], a["duration_ms"]
    return [a, b]


def enforce_min_shots(scene, shots):
    """After the one re-ask, guarantee the floor mechanically."""
    dur = max(sum(int(s.get("duration_ms") or 0) for s in shots),
              int(scene.get("duration_ms") or 0))
    need = min_shots(dur, scene.get("type"))
    if len(shots) < need and dur > sum(int(s.get("duration_ms") or 0) for s in shots):
        # The shots under-fill the scene: give the longest the slack first so
        # the splits below have something to cut.
        i, longest = max(enumerate(shots),
                         key=lambda t: int(t[1].get("duration_ms") or 0))
        longest["duration_ms"] = int(longest.get("duration_ms") or 0) + (
            dur - sum(int(s.get("duration_ms") or 0) for s in shots))
    guard = 0
    while len(shots) < need and guard < 16:
        guard += 1
        i, longest = max(enumerate(shots),
                         key=lambda t: int(t[1].get("duration_ms") or 0))
        if int(longest.get("duration_ms") or 0) < 2 * SHOT_MIN_MS:
            break
        shots[i:i + 1] = split_shot(longest)
    return shots


# ------------------------------------------------------------- normalizing ---
class PlanError(ValueError):
    pass


def normalize_story(data):
    """Validate + tidy the writer/editor artifact in place."""
    if not isinstance(data, dict) or not isinstance(data.get("scenes"), list) or not data["scenes"]:
        raise PlanError("story has no scenes")
    data["characters"] = [c for c in (data.get("characters") or []) if c.get("name")]
    for c in data["characters"]:
        c["role"] = (c.get("role") or "supporting").strip().lower()
        if c["role"] not in ("lead", "supporting", "extra"):
            c["role"] = "supporting"
    data["environments"] = [e for e in (data.get("environments") or []) if e.get("name")]
    world = data.get("world") if isinstance(data.get("world"), dict) else {}
    world.setdefault("props", [])
    world["props"] = [p for p in world["props"] if isinstance(p, dict) and p.get("name")]
    data["world"] = world
    for i, s in enumerate(data["scenes"]):
        s["slug"] = (s.get("slug") or f"SC_{i + 1:02d}").strip()[:24].replace(" ", "_").upper()
        s["cast"] = [c for c in (s.get("cast") or []) if isinstance(c, str) and c.strip()]
        s["type"] = (s.get("type") or "dialogue").strip().lower()
        s["duration_ms"] = int(s.get("duration_ms") or 12000)
        if not isinstance(s.get("vfx_ref"), dict) or not (s.get("vfx_ref") or {}).get("prompt"):
            s["vfx_ref"] = None
        beats = [b for b in (s.get("beats") or []) if isinstance(b, dict)]
        if not beats:
            # A scene with prose but no beats still planable: one beat from the purpose.
            beats = [{"label": "the scene", "intent": s.get("purpose"),
                      "action": s.get("purpose") or s.get("scene_prompt") or s["slug"],
                      "dialogue": []}]
        for j, b in enumerate(beats):
            b["label"] = str(b.get("label") or f"beat {j + 1}").strip()[:48]
            b["action"] = (b.get("action") or b.get("intent") or "").strip()
            b["dialogue"] = [d for d in (b.get("dialogue") or [])
                             if isinstance(d, dict) and d.get("line")]
        s["beats"] = beats
    return data


def union_named_cast(have, text, candidates):
    """`have`, plus everyone `text` actually names, in a stable order.

    Longest name first WITH SPAN CONSUMPTION, which is the whole difficulty in
    a cast like this project's: "Guide Rei", "Knight Rei" and "Rei" are three
    people, and a plain substring test says every sentence mentioning the guide
    also mentions Rei. Consuming "Guide Rei" from the text first leaves the
    later bare "Rei" to match on its own — so the sentence that names both gets
    both, and one that names only the guide gets only the guide.

    Matched on the BASE name (before " — "), because an outfit variant is cast
    as "Rei — Travel-worn survivor outfit" and written about as "Rei".
    """
    base = {}
    for n in candidates:
        if isinstance(n, str) and n.split(" — ")[0].strip():
            base.setdefault(n.split(" — ")[0].strip(), n)
    out = list(have)
    left = f" {text or ''} "
    for b in sorted(base, key=len, reverse=True):
        pat = re.compile(rf"\b{re.escape(b)}\b", re.I)
        if not pat.search(left):
            continue
        left = pat.sub(" ", left)
        pick = base[b]
        # The scene may cast the variant while the prose says the base name;
        # either spelling already present counts as covered.
        if not any(c == pick or c.split(" — ")[0].strip().lower() == b.lower()
                   for c in out):
            out.append(pick)
    return out


def normalize_shots(cine, story):
    """Validate the cinematographer artifact against the story; returns
    {slug: [shot,...]} covering every scene (raises when a scene is missing
    and unfixable)."""
    by_slug = {}
    for sc in (cine or {}).get("scenes") or []:
        slug = str(sc.get("slug") or "").strip().upper()
        shots = [sh for sh in (sc.get("shots") or []) if isinstance(sh, dict)
                 and (sh.get("action") or sh.get("camera"))]
        if slug and shots:
            by_slug[slug] = shots
    out = {}
    known = {c["name"] for c in story.get("characters") or []}
    for scene in story["scenes"]:
        shots = by_slug.get(scene["slug"])
        if not shots:
            # Deterministic degradation: one shot per narrative beat.
            shots = [{"beat": b["label"], "duration_ms": 4000,
                      "camera": "a medium shot; the camera holds a static shot",
                      "action": b["action"], "dialogue": list(b.get("dialogue") or []),
                      "cast": list(scene.get("cast") or []), "sfx": None}
                     for b in scene["beats"]]
        for sh in shots:
            sh["action"] = (sh.get("action") or "").strip()
            sh["camera"] = (sh.get("camera") or "").strip() or None
            sh["duration_ms"] = int(sh.get("duration_ms") or 4000)
            cast = [n for n in (sh.get("cast") or []) if isinstance(n, str)]
            kept = [n for n in cast if n in known or n in (scene.get("cast") or [])]
            # UNION, not a fallback. This was `kept or [names in the action]`,
            # so the second half ran only when the model sent NO cast at all —
            # and the failure mode is a shot that lists SOME of its people.
            # Measured: "Guide Rei snaps her head toward Rei and raises one
            # gloved hand between Rei's face and the pane" came back with
            # cast ["Guide Rei"]. `beats.meta.cast` is what `panelSpec` stages
            # sheets from, so the panel was drawn with one face reference and
            # Rei simply was not in it — the shot is ABOUT the two of them.
            # Dialogue first, flag coerced — the cast union below reads it.
            sh["dialogue"] = [d for d in (sh.get("dialogue") or [])
                              if isinstance(d, dict) and d.get("line")]
            for d in sh["dialogue"]:
                if coerce_offscreen(d.get("offscreen")):
                    d["offscreen"] = True
                else:
                    d.pop("offscreen", None)
            # A speaker joins the cast by their line — EXCEPT an offscreen
            # one, which is the DP saying the camera is elsewhere while the
            # voice continues. Unioning that name puts the speaker into the
            # cutaway's cast, and `beats.meta.cast` is what stages sheets and
            # keeps positions: the V.O. would draw its own speaker.
            sh["cast"] = union_named_cast(
                kept, f"{sh['action']} " + " ".join(
                    str(d.get("speaker") or "") for d in sh["dialogue"]
                    if not d.get("offscreen")),
                (scene.get("cast") or []) + sorted(known))
            # Positions are kept only for people actually in the shot: a
            # position line for someone out of frame reads to the renderer as
            # an instruction to put them there.
            pos = sh.get("positions")
            sh["positions"] = ({str(k): v.strip() for k, v in pos.items()
                                if isinstance(v, str) and v.strip()
                                and str(k) in sh["cast"]}
                               if isinstance(pos, dict) else {})
        reconcile_dialogue(scene, shots)
        attach_beats(scene, shots)
        out[scene["slug"]] = shots
    return out


# ------------------------------------------------------------ stage prompts --
WRITER_CONTRACT = """Return ONLY a JSON object, no prose:
{
  "title": "...",
  "world": {"era": "when this is (year/period/technology level)",
            "technology": "what exists and what doesn't",
            "palette": "3-5 named colors that define the whole piece",
            "motifs": ["recurring image", ...],
            "style_notes": "one sentence a production designer could enforce",
            "vfx_language": "ONE sentence when the piece has magic/energy/
             impossible effects: the visual grammar every effect obeys —
             signature color(s), form (ribbons/motes/arcs/geometry), and how
             it lights whatever it touches. Omit for pieces without effects.",
            "props": [{"name": "...", "look": "concrete visual description",
                       "why": "why the story turns on it", "scenes": ["SLUG"],
                       "reads": "for a READABLE only — the exact visible text",
                       "depicts": "for an ILLUSTRATED prop only (sketchbook,
                       photograph, portrait) — the exact name of the character
                       shown on it",
                       "fixed_to": "for a prop FIXED to one location (a sign, a
                       fitting, a machine) — that location's name; omit for
                       anything carried"}]},
  "characters": [
    {"name": "...", "role": "lead|supporting|extra",
     "summary": "1-2 sentences",
     "identity_line": "ONE sentence, 6-8 concrete visual attributes, opening
      with APPARENT AGE and then hair style+color, eyes, build, distinguishing
      mark, exact outfit pieces with colors, accessories — repeatable verbatim
      in every shot. Age is not optional and never lives only in the summary:
      this sentence is the ONLY description the face plate is drawn from and it
      is repeated into every shot, so an ageless line renders a
      twenty-two-year veteran as a man in his thirties",
     "personality": "...", "wardrobe": "...",
     "voice": "pitch + timbre + pace + accent, e.g. 'a low, gravelly voice,
      slow deliberate pace'",
     "speech_pattern": "HOW they talk, distinct from everyone else: vocabulary
      register, sentence rhythm (clipped/rolling/interrupting), one verbal tic,
      and one thing they would never say", "want": "what they want in this piece",
     "singer": false,
     "outfits": [{"name": "outfit name", "look": "exact pieces with colors",
                  "scenes": ["SLUG", ...]}]}
  ],
  "environments": [
    {"name": "...", "summary": "...",
     "identity_line": "one sentence locking the location's look, consistent
      with world.era and world.palette",
     "palette": "3-4 colors",
     "scale": "the size of the space in human terms — footprint, ceiling
      height, how far the eye can see",
     "features": ["2-4 named fixtures a shot can anchor to — 'the freight
      lift', 'the glass bridge', 'the teller cage'"],
     "background_life": "who and what populates the space by default (crowd
      density, drones, steam, gulls, signage) — 'empty, and the emptiness is
      the point' is a valid answer",
     "light_sources": "the light the place makes for itself (neon, skylight,
      fire, monitors)",
     "sound": "what the place sounds like before anyone speaks"}
  ],
  "scenes": [
    {"slug": "SHORT_SLUG", "purpose": "what this scene is FOR — what the
      audience knows/feels entering and leaving",
     "conflict": "who wants what against what, in this scene",
     "emotion_in": "trust", "emotion_out": "doubt",
     "type": "dialogue|action|montage|quiet",
     "environment": "environment name", "cast": ["every character on screen"],
     "time": "time of day", "duration_ms": 24000,
     "entrances": "how each character got here from their last scene",
     "ending": "the exact image/state the scene ends on",
     "beats": [
       {"label": "short handle, e.g. 'the reveal'",
        "intent": "what changes emotionally in this beat",
        "action": "what physically happens, present tense, concrete",
        "dialogue": [{"speaker": "name", "line": "...", "delivery": "tone"}]}
     ],
     "vfx_ref": {"name": "effect name", "prompt": "a single still image
       showing the scene's key effect: color, material, light, composition"}}
  ],
  "soundscape": "1-3 sentences", "music": "1-3 sentences"
}
Rules: NO camera language anywhere — cameras are the cinematographer's job.
Environments are PLACES, not backdrops: every one gets scale, named anchor
features, background_life, its own light and its own sound — the
cinematographer will stage positions against your named features, and
background_life is what makes a space feel inhabited on screen.
One environment is ONE SETUP. Its reference plates are four angles on the
same view, so a place seen BOTH from outside and from within is two
environments, named "<PLACE> — EXTERIOR" and "<PLACE> — INTERIOR", each with
its own scale, features and light, and scenes cast whichever one they play
in. An observatory approached across a field and then sheltered inside is
not one location with two moods; it is a building and a room, sharing
nothing a reference picture can hold.
Props are ANY object the plot turns on — documents, letters, photographs,
maps, books, screens and signs included: if the audience must read it or
recognize it, it is a prop with a concrete `look` (and `reads` when it
carries text — generated video will otherwise typeset its own words).
Say `depicts` whenever a prop SHOWS a person (a sketchbook of drawings, a
photograph, a portrait): unstated, the renderer draws whichever character it
has seen most of, which is how a book of drawings of one character came back
full of drawings of another. Say `fixed_to` for anything mounted in a place
rather than carried, so it can be photographed where it actually hangs.
Dialogue is written in each speaker's OWN speech_pattern — if two
characters' lines could be swapped without anyone noticing, rewrite them
until they can't. Dialogue is SPOKEN, not written: contractions always;
fragments; interruptions (a line may end mid-thought with "—"); people
deflect, answer sideways, talk past each other — they collide wants, they
do not exchange information in complete balanced sentences. Nobody states
their own emotion ("I'm scared") when what they DO say can show it; nobody
recaps what both speakers already know; nobody uses the other's name more
than once per scene. `delivery` is a performance note ("through a held
breath", "grinning", "flat, not looking up"), not an adverb. A line may
carry ONE VOCAL EVENT the voice engine performs, written inline in
parentheses from exactly this set — (laugh), (sigh), (cough), (clears
throat) — e.g. "(sigh) It's good to hear your voice again." Use one where the
breath IS the line, a few per scene at most; anything else in parentheses is
a stage direction no engine reads and belongs in `delivery`. The test for
every line: would this person say this, at this moment, to THIS person, out
loud? If it reads like written dialogue, break it until it sounds found.
Dialogue is attached to the beat where it is spoken. 3-6 beats per scene;
a beat is one emotional/physical change (enter, greet, reveal, silence,
leave), not a summary. Every named speaker and every on-screen person is in
characters[] — supporting roles included, each with a full identity_line and
voice, because anyone without one renders with a different face every shot.
Characters must not appear in locations their entrances can't explain.
Scene durations must sum to roughly the target, and the WHOLE SCRIPT must
stay within `dialogue_line_budget` spoken lines. That budget is not a style
note: every line is performed at natural speaking pace and its shot is GROWN
to fit the recording, so writing past it does not make a denser episode, it
makes a longer one than was asked for. If the story needs more beats than the
budget has lines, spend them on action and reaction, not on more talk.
World cohesion is law: every
environment and outfit obeys world.era, world.technology and world.palette.
Only list outfits when the story needs a wardrobe change; scenes not listed
use the identity_line outfit."""

EDITOR_CONTRACT = """You are the story editor. Do not add lore, characters or
locations. Judge the DRAMA of the story you were handed:
- Does every scene have conflict? Name any scene where nobody wants anything.
- Repetition: scenes or beats that repeat an earlier scene's work.
- The middle: does it sag? Does the ending pay off the opening's promise?
- Dialogue: cut exposition people would never say; keep subtext.
- Pacing: where a quiet beat earns a loud one, and where loudness is empty.
Return ONLY JSON:
{"notes": [{"scene": "SLUG", "problem": "...", "fix": "..."}],
 "revised": { the COMPLETE story object, same schema as you received, with
              your fixes applied }}
Keep every schema field. If the story is already sound, return it unchanged
with an empty notes list."""

VOICE_CONTRACT = """You are the dialogue polish — a script doctor whose ONLY
brief is voice. The story, its events, scenes, beats and who speaks when are
LOCKED. You are handed the characters (personality, speech_pattern, want) and
every scene's beats. Rewrite only the LINES that fail this test: covering the
speaker's name, could a reader tell who is talking? Lines that already pass
come back unchanged.
Rules:
- Same speaker, same beat, same count of lines, same information and intent
  per line — you change HOW it is said, never WHAT it does.
- Each character's lines obey their speech_pattern: their vocabulary, their
  rhythm, their tic. Two characters must never be interchangeable.
- Subtext over statement: people say things AT each other, not about
  themselves. Cut any line that explains what the audience can see.
- Kill screenwriter-ese and AI cadence on sight: "I need you to understand",
  "We don't have much time", "It's what they would have wanted", tidy
  call-and-response, every line a complete balanced sentence. Real people
  trail off, interrupt with "—", give one-word answers, answer the wrong
  question on purpose, talk in half-thoughts. An exchange should read like
  it was overheard, not composed.
- Give `delivery` as a performance note wherever the read isn't obvious
  ("through a held breath", "grinning", "flat, not looking up").
- A line may open with or contain ONE performed vocal event from this set
  only, in parentheses: (laugh), (sigh), (cough), (clears throat). Keep any
  the writer placed unless the line no longer earns it; never add "(beat)",
  "(pause)" or any other parenthetical — those reach no engine.
- Keep each line within ±40% of its current word count — these lines are
  timed to shots.
Return ONLY JSON:
{"scenes": [{"slug": "SLUG",
             "beats": [{"idx": 0, "dialogue": [{"speaker": "name",
                        "line": "...", "delivery": "tone"}]}]}]}
Include ONLY beats where you changed at least one line; `idx` is the beat's
position in that scene (0-based). Keep every speaker exactly as given."""

BLOCKING_CONTRACT = """You are the continuity director. The story is locked;
you write the scene's PHYSICAL ground truth — where every body is, every
beat, so five independently rendered shots share one room. Return ONLY JSON:
{"scenes": [
  {"slug": "SLUG",
   "map": "ONE sentence of stable geography relating the scene's named
    features — what is left/right/opposite/above what, distances in human
    terms ('the teller cage faces the entrance across ten meters of lobby')",
   "start": {"CharacterName": {"at": "a named feature or clear spot",
             "facing": "a feature or another character",
             "doing": "standing|seated|leaning|crouched|..."}},
   "beats": [{"idx": 0, "changes": {"CharacterName": {"at": "...",
              "facing": "...", "doing": "standing|seated|leaning|..."}}},
             {"idx": 2, "changes": {"Someone": {"at": "the doorway",
              "facing": "the room", "doing": "standing", "enters": true}}},
             {"idx": 5, "changes": {"Someone": {"exits": true}}}]}
]}
`enters` and `exits` are SEPARATE BOOLEAN KEYS of the change object, never
values of `doing`. Write `{"exits": true}` — never `"doing": "exits"`, and
never `"doing": "exits": true`, which is not valid JSON and costs every scene
in this response, not just that one. `doing` is always a posture.
Rules: every scene cast member gets a `start` entry, or an `enters` change in
the beat they arrive (with `at` where they appear from). A character's
position changes ONLY through a `changes` entry, and a change is a visible
physical action a shot can show. `facing` matters — it is screen direction:
two people in conversation face each other unless the drama says otherwise,
and a facing flip is a change. Anchor every `at` to the environment's named
features. The map stays true for the whole scene. Only include beats where
something changes."""

CINE_CONTRACT = """You are the cinematographer. The story is locked: do not
invent events, characters, locations or dialogue lines, and do not drop any.
Your one job is the question a DP answers every day: what is the best way to
SHOW each beat?

For every scene, decompose each narrative beat into 1-4 shots. Return ONLY:
{"scenes": [
  {"slug": "SLUG",
   "shots": [
     {"beat": "the beat label this shot serves",
      "duration_ms": 3500,
      "camera": "shot size + angle + official motion grammar, e.g. 'a wide
       establishing shot at eye level; the camera pushes in with small
       amplitude at slow speed' or 'an over-the-shoulder close-up behind Leon;
       the camera holds a static shot'",
      "action": "what happens IN THIS SHOT, present tense, concrete physics —
       who/what/where-in-frame; state consequences",
      "positions": {"CharacterName": "where they are, against the scene's
       named anchor features — 'at the teller cage', 'on the catwalk above
       the vault'"},
      "cast": ["ONLY those visibly in frame"],
      "dialogue": [{"speaker": "name", "line": "the exact line from the beat",
                    "delivery": "tone",
                    "offscreen": "true ONLY when the line is heard while the
                     camera is elsewhere — a listener reaction, an insert of
                     the thing discussed — and its speaker is deliberately
                     out of this shot. The line plays as voice-over."}],
      "sfx": "diegetic sound of this shot"}
   ]}
]}
Craft rules:
- Coverage, not summary: establish geography wide when a location is new or
  positions changed; go closer as intensity rises; cut to inserts for objects
  that matter; give reactions their own shots — the listener's face is often
  the story.
- A scene may carry `blocking` — the continuity director's map, start
  positions and per-beat changes. That is GROUND TRUTH: your `positions`
  restate the blocking state at each shot's beat, and you choose the CAMERA,
  never the geography. A character is only ever where the blocking has them.
- Geography is stated, not implied: use the environment's named features as
  anchor positions and fill `positions` for EVERY shot with two or more cast
  — in action scenes this is mandatory. A character changes position only
  through visible movement in a shot ("crosses to", "vaults down to"), and
  the destination appears in the next shot's positions. These clips render
  independently: any position you leave implied WILL drift between them, and
  two characters you never separate on paper will render side-by-side even
  when the scene needs them apart.
- Shot sizes and setups VARY. Never two consecutive shots with the identical
  setup; never let one setup carry more than a third of the piece. Use the
  size vocabulary (extreme wide/wide/full/medium/medium close-up/close-up/
  extreme close-up/insert/over-the-shoulder/two-shot/POV) and angles (eye
  level/low/high/overhead/dutch).
- Motion uses ONLY the official vocabulary (Zoom/Push/Pull/Pan/Truck/Tilt/
  Pedestal/Arc Shot/Tracking Shot/Static Shot/Shake/POV/Roll) with amplitude
  and speed stated when meaningful. Pick the move that serves the beat's
  intent — a push-in is earned by revelation or resolve, not a default.
- Dialogue: place each line in the shot where it is spoken; a shot holding a
  line must be long enough to say it (~2.4 words/sec plus a breath). Prefer
  cutting to the listener DURING a long line over stretching one angle — and
  the cut does not wait for the words to stop: put the later lines of a long
  explanation in the LISTENER's shot, or in an insert of the thing being
  discussed, marked "offscreen": true. The voice carries over the cutaway as
  voice-over while the speaker stays out of frame. An offscreen line's shot
  still needs that line's speaking time; its speaker goes in neither that
  shot's `cast` nor its `action`; and a speaker's FIRST line in a scene is
  never offscreen — the audience sees who is talking before the camera
  leaves them.
- Action beats (type=action): one physical exchange per shot — intention →
  strike → impact → consequence — and the exchange plays at FIGHT SPEED,
  written into both fields. Action text uses fast, weighted verbs (drives,
  slams, whips, hurls — never 'moves toward' or 'begins to') and states the
  impact's physical consequence (a body staggers, dust jumps, a rack of
  shelving goes over, breath knocked visible). The camera PARTICIPATES:
  tracking shots with large amplitude at fast speed through exchanges, a
  fast push-in on a landed hit, a shake with small amplitude at fast speed
  at the moment of impact — a static camera in a fight is only ever the
  wide that re-establishes geography, and never twice in a row. Exchange
  shots run SHORT (2000-3500ms); speed contrast sells force — a slow
  circling shot is there to make the explosion after it read as fast.
  Abilities used in combination get one shot where BOTH cast members'
  actions are named as a single coordinated move.
- Quiet beats deserve stillness: a static hold IS a choice when the beat is
  weight, not spectacle."""


def writer_messages(brief_json, treatment):
    msgs = [{"role": "user", "content": brief_json}]
    if treatment:
        msgs += [{"role": "assistant", "content": treatment[:8000]},
                 {"role": "user", "content":
                     "Now write the story structure JSON exactly per the contract, "
                     "keeping every decision from the treatment."}]
    return msgs


def editor_messages(story):
    return [{"role": "user", "content": json.dumps(story, ensure_ascii=False)}]


def voice_messages(story):
    doc = {
        "characters": [{k: c.get(k) for k in
                        ("name", "personality", "speech_pattern", "voice",
                         "want", "role") if c.get(k)}
                       for c in story.get("characters") or []],
        "scenes": [{"slug": s["slug"], "purpose": s.get("purpose"),
                    "conflict": s.get("conflict"),
                    "beats": [{"idx": i, "label": b.get("label"),
                               "action": b.get("action"),
                               "dialogue": b.get("dialogue") or []}
                              for i, b in enumerate(s.get("beats") or [])]}
                   for s in story["scenes"] if any(
                       b.get("dialogue") for b in s.get("beats") or [])],
    }
    return [{"role": "user", "content": json.dumps(doc, ensure_ascii=False)}]


def merge_voice_pass(story, data):
    """Fold the dialogue polish back into the story, defensively: a beat's
    rewrite is applied only when it names the same speakers in the same order
    and stays within the length bounds the shot timing depends on. Returns
    the number of lines changed."""
    changed = 0
    by_slug = {s["slug"]: s for s in story.get("scenes") or []}
    for sc in (data or {}).get("scenes") or []:
        scene = by_slug.get(str(sc.get("slug") or "").strip().upper())
        if not scene:
            continue
        beats = scene.get("beats") or []
        for rb in sc.get("beats") or []:
            try:
                idx = int(rb.get("idx"))
            except (TypeError, ValueError):
                continue
            if not 0 <= idx < len(beats):
                continue
            old = beats[idx].get("dialogue") or []
            new = [d for d in (rb.get("dialogue") or [])
                   if isinstance(d, dict) and d.get("line")]
            if len(new) != len(old):
                continue
            if any((n.get("speaker") or "").strip().lower()
                   != (o.get("speaker") or "").strip().lower()
                   for n, o in zip(new, old)):
                continue
            # ±40% word count, floor of 3 either way — a 2-word line may
            # legitimately become 4.
            ok = all(abs(words(n["line"]) - words(o.get("line"))) <=
                     max(3, int(words(o.get("line")) * 0.4))
                     for n, o in zip(new, old))
            if not ok:
                continue
            for n, o in zip(new, old):
                if n["line"].strip() != (o.get("line") or "").strip():
                    changed += 1
                o["line"] = n["line"]
                if n.get("delivery"):
                    o["delivery"] = n["delivery"]
    return changed


# --------------------------------------------------- dialogue validators ----
# Markers a speech_pattern can promise, and how to tell whether the lines
# actually keep the promise. Same shape as dialogue_synth.TAG_MAP: the
# writer's prose intent mapped onto something checkable, deterministically.
# Aki's pattern said "names colors, counts things, quotes exact times" and
# across 30 delivered lines ZERO contained a colour word — a promise nothing
# was checking.
VOICE_MARKERS = [
    (("colour", "color", "palette", "hue"), "a colour word",
     re.compile(r"\b(indigo|rose|grey|gray|amber|blue|red|green|yellow|black|"
                r"white|orange|violet|copper|sodium|crimson|teal|gold|silver)\b", re.I)),
    (("count", "number", "numeric", "tally", "arithmetic"), "a number",
     re.compile(r"\b(one|two|three|four|five|six|seven|eight|nine|ten|"
                r"eleven|twelve|dozen|\d+)\b", re.I)),
    (("time", "timestamp", "o'clock", "clock", "precise time"), "a time",
     re.compile(r"\b(\d{1,2}[:.]\d{2}|midnight|noon|dawn|o.clock|"
                r"seconds?|minutes?|hours?)\b", re.I)),
    (("frequenc", "megahertz", "mhz", "signal", "channel"), "a frequency or channel",
     re.compile(r"\b(\d+(\.\d+)?\s?(mhz|khz|hz)|frequency|band|channel|signal)\b", re.I)),
    (("question",), "a question mark", re.compile(r"\?")),
]

# A line that narrates its speaker's own inner state. Real people show it.
_STATES_OWN_EMOTION = re.compile(
    r"\b(i(?:'m| am)\s+(?:so\s+)?(?:scared|afraid|angry|sad|happy|sorry|"
    r"terrified|confused|worried|nervous|excited|frustrated|tired|lost)"
    r"|i feel\b|i'm feeling\b|i don't know how to feel)", re.I)

_ENDS_COMPLETE = re.compile(r"[.!?][\"”’']?\s*$")
_INTERRUPTED = re.compile(r"[—–]\s*$|--\s*$|[—–]")

COMPLETE_RATE_MAX = 0.85   # above this, an exchange reads as composed
MIN_LINES_FOR_VOICE = 5    # fewer than this and a name cannot establish one


def dialogue_issues(story):
    """Deterministic style failures across the whole script, phrased as
    re-ask instructions. Pure.

    Every rule here was measured failing on a real episode: E2 delivered
    91-100% complete grammatical sentences against a contract that asks in
    plain language for trailing off and interruptions, 0 colour words from a
    character whose defining tic is naming colours, and 91% of all lines to
    two of four speakers. The contract said all the right things and the
    model agreed and ignored it — which is exactly what a validator is for
    in this pipeline (see blocking_issues, camera_issues)."""
    issues = []
    scenes = story.get("scenes") or []
    all_lines = [(d, s) for s in scenes for b in s.get("beats") or []
                 for d in b.get("dialogue") or [] if (d.get("line") or "").strip()]
    if not all_lines:
        return issues

    # -- per scene: composed-sounding exchanges, and exchanges with no seams
    for s in scenes:
        lines = [d for b in s.get("beats") or [] for d in b.get("dialogue") or []
                 if (d.get("line") or "").strip()]
        if len(lines) < 3:
            continue
        texts = [d["line"].strip() for d in lines]
        complete = sum(1 for t in texts if _ENDS_COMPLETE.search(t)) / len(texts)
        if complete > COMPLETE_RATE_MAX:
            issues.append(
                f"{s['slug']}: {complete:.0%} of the lines are complete "
                f"grammatical sentences. Break at least "
                f"{max(1, int(len(texts) * 0.25))} of them — trail off "
                f"mid-thought, answer with one word, or cut a line short "
                f"where the other speaker takes over")
        if len(texts) >= 4 and not any(_INTERRUPTED.search(t) for t in texts):
            issues.append(
                f"{s['slug']}: nobody interrupts anybody across "
                f"{len(texts)} lines. Write at least one interruption as a "
                f"cut-off — the interrupted line ends in an em dash and the "
                f"next speaker's line starts mid-thought")

    # -- per character: the tics their own profile promised, and stated feeling
    by_speaker = {}
    for d, _s in all_lines:
        nm = (d.get("speaker") or "").strip()
        if nm:
            by_speaker.setdefault(nm, []).append(d["line"])
    for c in story.get("characters") or []:
        nm = (c.get("name") or "").strip()
        mine = by_speaker.get(nm) or []
        if not mine:
            continue
        pat = " ".join(str(c.get(k) or "") for k in ("speech_pattern", "personality"))
        low = pat.lower()
        for keys, label, rx in VOICE_MARKERS:
            if any(k in low for k in keys) and not any(rx.search(l) for l in mine):
                issues.append(
                    f"{nm}: their speech pattern promises {label} and not one "
                    f"of their {len(mine)} lines contains it. Rewrite at least "
                    f"two of {nm}'s lines so the tic is on the page")
        stated = [l for l in mine if _STATES_OWN_EMOTION.search(l)]
        if stated:
            issues.append(
                f"{nm}: states their own feeling out loud "
                f"(\"{stated[0][:48]}\"). Replace it with something they DO "
                f"or notice that shows it instead")

    # -- whole script: a name with too few lines is a function, not a person
    for c in story.get("characters") or []:
        nm = (c.get("name") or "").strip()
        n = len(by_speaker.get(nm) or [])
        if 0 < n < MIN_LINES_FOR_VOICE and (c.get("role") or "").lower() != "extra":
            issues.append(
                f"{nm} speaks only {n} time(s) in the whole script — too few "
                f"to be a person rather than a delivery mechanism. Give them "
                f"at least {MIN_LINES_FOR_VOICE} lines across the scenes they "
                f"are in, including one that serves no plot purpose")
    return issues


# ------------------------------------------------------------- PUNCH-UP ----
# Comedy's twin of the FIGHT CHOREOGRAPHER, and it exists for the same reason:
# a genre whose whole point is a specific craft was being written by a general
# dramatist. The comedy persona in director/personas.js is four lines about
# CAMERA ("set up in a wide, pay off in a cut") and says nothing about how a
# joke is built, so a sitcom brief came back as a drama with light banter.
#
# Like the choreographer this is a rewrite-only stage over LOCKED story: it
# changes how lines land, never what happens, and `merge_voice_pass` enforces
# that mechanically (same speakers, same count, ±40% words — the lines are
# timed to shots).
PUNCHUP_CONTRACT = """You are the PUNCH-UP — the comedy writer a sitcom script
goes to last. The story, the scenes, the beats, who is in them and what
happens are LOCKED. You rewrite LINES so they play, and nothing else.

How a sitcom line works, and what you are actually doing:
- JOKES SIT AT THE END. The funny word goes last in the line, and the funny
  line goes last in the exchange. Move the reveal to the end of the sentence;
  never explain after the laugh. If a line lands and the next line comments
  on it, cut the comment.
- EVERY SCENE ENDS ON A BUTTON. The last line of a scene is the hardest line
  in it — a topper, a reversal, or the wrong person being right. A scene that
  trails off into action has thrown its ending away.
- SPECIFIC IS FUNNY, GENERAL IS NOT. "a sandwich" is nothing; "an egg salad
  sandwich he has been describing since Tuesday" is a joke. Name the brand,
  the number, the day of the week.
- CHARACTER OVER GAG. A line is only funny from THIS person: it should be a
  joke nobody else in the cast could have made. Deliver the same information
  their way, or hand the joke to whoever it belongs to (without changing who
  speaks — if the wrong person has the joke, weaken theirs and let the reply
  top it).
- COMEDY IS REACTIVE. Somebody has to be the straight man. The funniest line
  in an exchange is often the flat, literal answer to an absurd statement.
- THE THIRD ONE IS THE TWIST. Where a list or a repetition already exists in
  the beat, make it three, and make the third one break the pattern.
- CONFIDENCE, NOT WINKING. Characters never signal that they are joking, never
  say "I'm kidding", never laugh at their own line.
- RUNNERS PAY OFF. If a distinctive phrase or object appears early, bring it
  back later in the episode, changed by what has happened.

Hard limits:
- Same speaker, same beat, same number of lines, same information and intent.
- Stay within +/-40% of each line's word count. Lines are timed to shots and
  a longer line is a line cut off at the edit.
- No stage directions in the line text — no "(beat)", no "(pause)". The
  ONLY parentheticals allowed are the four vocal events the voice engine
  performs: (laugh), (sigh), (cough), (clears throat), at most one per line.
  Any other performance note goes in `delivery`.
- No audience reactions, no laugh track, no narration.

Return ONLY JSON:
{"scenes": [{"slug": "SLUG",
             "beats": [{"idx": 0, "dialogue": [{"speaker": "name",
                        "line": "...", "delivery": "tone"}]}]}]}
Include ONLY beats you changed; `idx` is the beat's 0-based position in that
scene. Keep every speaker exactly as given."""


# A sitcom is dialogue-dense: talk is the medium. Below this a comedy scene
# is playing as drama whatever its lines say. Derived, not measured on our own
# takes: at our shot floors (a 4-word line is ~1.5s plus the 500ms handoff)
# 8 lines/minute is comfortably renderable, while a 30s scene with 3 lines —
# which is what a dramatist writes — is 6.
MIN_LINES_PER_MIN = 8.0
# One speaker owning more than this share of a scene's lines has no foil, and
# comedy is reactive. Only checked where two or more people actually speak.
FOIL_SHARE_MAX = 0.72
_RUNNER_N = 2          # phrase length for callback detection
_RUNNER_WORD_LEN = 7   # a single word distinctive enough to BE the runner
_RUNNER_STOP = frozenset(
    "a an and are as at be but by do for from get go got had has have he her "
    "him his how i if in is it its just like me my no not of off oh on or our "
    "out say she so that the their them then there they this to too up us was "
    "we well what when who why will with you your".split())


def _phrases(text, n=_RUNNER_N):
    """What could be a callback in this line: n-grams that are not all filler,
    plus long single words.

    The single words matter and were added because the check got it WRONG on
    the first real sitcom it saw. That episode's runner was one adverb —
    "Operationally", Reg's verbal tic, planted in scene 2 and paid off as the
    final line of the tag ("Operationally, I've been abandoned") — and a
    3-gram scan could not see it, because the words AROUND it changed every
    time, which is exactly what a good callback does. The check duly reported
    "the episode has no runner" about an episode built on one, which is the
    false positive this file keeps warning about.

    Short words stay excluded so "Tuesday" (the premise, said everywhere) is
    not mistaken for a callback — but note the bar is deliberately generous:
    the failure this catches is a script with NO repetition anywhere, so
    erring toward silence is the right direction.
    """
    ws = re.findall(r"[a-z0-9']+", (text or "").lower())
    out = []
    for i in range(len(ws) - n + 1):
        g = ws[i:i + n]
        if all(w in _RUNNER_STOP for w in g):
            continue
        out.append(" ".join(g))
    out += [w for w in ws
            if len(w) >= _RUNNER_WORD_LEN and w not in _RUNNER_STOP]
    return out


def comedy_issues(story):
    """Deterministic comedy failures, phrased as re-ask instructions. Pure.

    Same discipline as `dialogue_issues` and `fight_issues`: every check is
    countable, and none of them can fire on prose that is already right. A
    check that flags correct writing is a re-ask every run and a warning
    nobody reads — the mistake the action-before-speech check made once.
    """
    issues = []
    scenes = story.get("scenes") or []

    for s in scenes:
        beats = s.get("beats") or []
        lines = [d for b in beats for d in b.get("dialogue") or []
                 if (d.get("line") or "").strip()]
        if len(lines) < 3:
            continue        # a 2-line scene has no shape to get wrong

        # -- the button. Only for a scene that TALKS: a deliberate visual gag
        # legitimately ends on action, and a scene with two lines in it is not
        # what this rule is about.
        if not (beats[-1].get("dialogue") or []):
            issues.append(
                f"{s['slug']}: {len(lines)} lines and then the scene ends on "
                f"silent action — it has no button. Move a line into the last "
                f"beat, or write one there: the hardest line in the scene is "
                f"its last, and it should top what came before")

        # -- density
        dur_ms = sum(int(b.get("duration_ms") or 0) for b in beats) \
            or int(s.get("duration_ms") or 0)
        if dur_ms >= 20000:
            per_min = len(lines) / (dur_ms / 60000.0)
            if per_min < MIN_LINES_PER_MIN:
                want = int(MIN_LINES_PER_MIN * dur_ms / 60000.0)
                issues.append(
                    f"{s['slug']}: {len(lines)} lines across "
                    f"{dur_ms / 1000:.0f}s is {per_min:.1f} lines a minute — "
                    f"that is a drama's pace. Comedy is dialogue-dense: get it "
                    f"to about {want} lines by breaking long speeches into "
                    f"exchanges and letting people answer each other")

        # -- the foil
        by = {}
        for d in lines:
            nm = (d.get("speaker") or "").strip()
            if nm:
                by[nm] = by.get(nm, 0) + 1
        if len(by) >= 2:
            top, n = max(by.items(), key=lambda kv: kv[1])
            share = n / len(lines)
            if share > FOIL_SHARE_MAX:
                issues.append(
                    f"{s['slug']}: {top} speaks {share:.0%} of the lines — "
                    f"nobody is playing off them. Comedy is reactive: give the "
                    f"other speakers short flat replies between {top}'s lines "
                    f"so the scene is an exchange rather than a monologue")

    # -- the runner, episode-level. A callback is the most characteristic
    # sitcom device there is, and its absence is countable: no distinctive
    # phrase said in one scene is ever said again in another.
    if len(scenes) >= 3:
        seen = {}
        for s in scenes:
            for b in s.get("beats") or []:
                for d in b.get("dialogue") or []:
                    for p in _phrases(d.get("line")):
                        seen.setdefault(p, set()).add(s.get("slug"))
        if not any(len(v) >= 2 for v in seen.values()):
            issues.append(
                "The episode has no runner: no distinctive phrase said in one "
                "scene is ever said again in another. Plant one line early and "
                "bring it back later, changed by what has happened since — the "
                "callback is what makes an episode feel written rather than "
                "assembled")
    return issues


_COMEDY_WORDS = re.compile(
    r"\b(comedy|comedic|sitcom|sit-com|farce|farcical|satire|satirical|"
    r"parody|spoof|slapstick|screwball|mockumentary|deadpan|absurdist|"
    r"funny|humou?rous|laugh|gag|witty|romcom|rom-com)\b", re.I)


def is_comedy(brief):
    """Whether this episode gets the punch-up.

    Read off the BRIEF (genre, tone, logline, notes, format), not off the
    delivered script: the stage has to be decided before the lines exist, and
    a writer who was never told it is a comedy will not have written one for
    a detector to notice. Pure."""
    if not isinstance(brief, dict):
        return False
    hay = " ".join(str(brief.get(k) or "") for k in
                   ("genre", "tone", "logline", "premise", "format", "medium",
                    "treatment", "notes", "title"))
    for k in ("world", "story", "song"):
        v = brief.get(k)
        if isinstance(v, dict):
            hay += " " + " ".join(str(x) for x in v.values()
                                  if isinstance(x, (str, int, float)))
    return bool(_COMEDY_WORDS.search(hay))


def punchup_messages(story):
    """The whole talking script, plus who these people are. The punch-up needs
    the CAST profiles as much as the voice pass does: 'a joke nobody else in
    the cast could have made' is unanswerable without them."""
    return voice_messages(story)


CHARACTER_VOICE_CONTRACT = """You are rewriting the lines of ONE character
and nobody else. You are given that character's profile, and the full script
with every line in order — the OTHER characters' lines are immutable context
and must come back exactly as given if you mention them at all.

Rewrite each of this character's lines so that, with the speaker labels
covered, a reader could pick them out of the script by voice alone. Their
vocabulary, their rhythm, their tic, their evasions — consistently, in every
scene, not just the showcase ones.

Rules:
- Same beat, same order, same count of lines, same information and intent per
  line. You change HOW it is said, never WHAT it does.
- Whatever their speech pattern promises, put it ON THE PAGE. A pattern that
  says they count things means numbers appear in their lines.
- Not every line is a complete sentence. Some trail off. Some are one word.
  Some answer a question that wasn't asked.
- Never let them state their own emotional state. They show it or they hide it.
- Keep each line within +/-40% of its current word count — these lines are
  timed to shots.
Return ONLY JSON:
{"scenes": [{"slug": "SLUG", "beats": [{"idx": 0,
   "dialogue": [{"speaker": "THE NAME", "line": "...", "delivery": "tone"}]}]}]}
Include ONLY beats containing a line you changed, and inside those beats
include ONLY this character's lines (with their position preserved by listing
them in the order they occur in that beat). `idx` is the beat's position in
its scene (0-based)."""


# The COMPOSER. Registered in `llm.stage_system` — an unregistered stage id
# used to KeyError inside an advisory try/except and log "skipped", which is
# how the dialogue-polish pass silently never ran for its whole life.
#
# It writes STRUCTURE, never the caption: `score_prompt` compiles the vendor
# format (invariant #6, one media kind over). What it replaces is the WRITER's
# one-line `music` field being handed to Music 3 verbatim — a mood where the
# model's own guide asks for genre, tempo, key, arc, production profile and
# named instruments, and says in as many words that real instruments carry a
# record where mood adjectives do not.
COMPOSER_CONTRACT = """You are the COMPOSER. The film is locked — you do not
change a frame of it. You are writing the SCORE BIBLE: the decisions a
composer makes once, before writing a note, that every cue then obeys.

You are given the world, the cast's wants, and every scene in order with its
purpose, its emotional turn and its length. Read the whole arc before you
answer: a score is one piece of music with a shape, not a mood applied evenly.

Rules:
- Name REAL instruments and REAL production techniques. "Brushed drums,
  upright bass, Rhodes through a tape delay" carries a record; "chill vibes"
  does not. Be specific about playing technique (bowed, felted, muted, close-
  miked) — that is what separates two cellos.
- This is UNDERSCORE. It plays beneath dialogue. Choose instruments and a
  register that leave the midrange free, and say so in `evolution` — which
  instrument is allowed under speech and which one only plays when nobody
  talks.
- ONE motif, attached to ONE thing in the story (a character, an object, a
  question). Say what it is musically (an interval, a shape, a rhythm) and
  what triggers it. A theme nobody can point at is a texture.
- The arc is the film's, not a song's. Where does the score withhold? Most
  scores are wrong because they play every scene at the same intensity.
- Pick a tempo and a key and commit to them. They are stated to the model.
- No lyrics, ever. This is instrumental unless the film is a musical.
- Do not describe pictures. No framing, no light, no colour — those belong to
  the cinematographer, and a caption full of them produces a song about a
  photograph.

Return ONLY JSON, no prose:
{"score": {
  "idiom": "genre and sub-genre of the MUSIC, 3-6 words",
  "bpm": 72,
  "key_scale": "D minor",
  "arc": "one sentence: how the score changes across the film, and where it
   withholds",
  "production": "one sentence: which era's mixing and mastering this sounds
   like, and the recording character",
  "instruments": ["4-6 instruments. NAME first, 2-4 words, technique only if
   it fits in them: 'felted upright piano', 'bowed vibraphone', 'muted
   trumpet'. Put HOW they are played in `evolution`, not here"],
  "evolution": "one sentence: how the arrangement enters and builds, and which
   instrument is the one that plays under dialogue",
  "motif": "one sentence: the recurring figure, described musically, and what
   in the story triggers it",
  "space": "one short phrase: the room, the reverb, the stereo width",
  "cues": [{"scene": "SLUG", "intent": "what the music is DOING in this scene
    — including 'silence' where the right answer is no music",
    "intensity": 0}]
}}
`intensity` is 0-5, where 0 is silence and 5 is the loudest the film ever
gets. Give a cue for EVERY scene, in order."""


# --- the FIGHT CHOREOGRAPHER -----------------------------------------------
#
# The combat adapter's author is blunt that the LoRA does not choreograph:
# "this is not a magic LoRA … If you only write `two people fighting`, the
# model will probably just have two people flail at high speed." His own
# recommended workflow is to have an LLM build the action sequence FIRST
# against the official H3 guides and only then hand it to H3 + the adapter.
# This is that stage — an eighth staffed specialist, run over ACTION scenes
# only, rewriting the shot ACTION prose and nothing else.
#
# Invariant #6 is intact: this rewrites structured beats, and `h3_prompt`
# compiles the envelope from them deterministically. The contract forbids
# `[Shot N]`, `<Subject N>`, timestamps and trigger tokens outright.
CHOREOGRAPHER_CONTRACT = """You are the FIGHT CHOREOGRAPHER. You are given the
ACTION scenes of a locked storyboard: their shots, who is in them, the camera
already chosen, and the geography. You rewrite ONE field — each shot's
`action` — so the fight is a chain of physical cause and effect instead of a
description of people fighting.

THE RULE THAT MATTERS MOST: never write "they fight", "they exchange blows",
"a brutal fight breaks out" or any summary of combat. Every shot must say WHO
moves first, WHAT they do, WHERE it lands on the other body, HOW the other
reacts, and WHY the next move follows from that reaction. A reader who has
never seen the film must be able to draw it.

THE RULE THAT IS EASIEST TO GET WRONG: ONE decisive action per shot, and the
CHAIN RUNS FROM SHOT TO SHOT — not inside one. You are given each shot's
duration in milliseconds. A performer needs roughly a second and a half for a
strike and the reaction to it, so a 3-second shot holds ONE technique and its
consequence, not four. Packing "he drives her back AND rams her into the wall
AND her boot skids AND she catches the rail AND her hip hits the housing" into
three seconds does not produce a fast fight — the model cannot perform any of
it in the time and falls back to two people generically grappling, which is
the exact failure this stage exists to prevent. Write the FIRST move and its
result in this shot, and put the next move in the next shot. Scale the amount
of action to the seconds you are given, every time.

THE OTHER HALF OF THAT RULE, AND IT IS NOT OPTIONAL: a shot CONTAINS its own
action from start to finish. One technique per shot means one WHOLE technique
— the move AND where it ends up — never a move in this shot and its landing in
the next one. Each shot is compiled into its own timestamped instruction and
rendered without knowing what its neighbours say, so a strike thrown in shot 2
and landed in shot 3 is performed TWICE, and an action left in progress at the
end of a shot is never completed at all: the next shot is told the previous one
already finished, and simply does not perform it. Both were measured on a real
duel — a kick thrown in one shot and landing on a pillar in the next came back
as two pillar kicks, and a disarm that began in the last shot of one segment
and completed in the first shot of the next was performed by neither, so the
weapon just appeared on the floor between cuts.

Concretely: never end a shot on "begins to", "starts to" or "is about to".
Never open a shot by completing, finishing or landing something the previous
shot started. A shot may INHERIT a state — she is already off balance, his
guard is already down, she is already holding the staff — and that is how the
chain runs; what it may not do is finish a movement that is still travelling.

Carry these through, in this order of importance:

1. CONSEQUENCE. A landed strike changes the body it lands on, and that change
   PERSISTS into later shots of the same fight: a guard drops and stays down,
   a leg buckles and the walk stays uneven, breathing gets ragged. Damage
   accumulates toward the finish rather than resetting between shots.
2. MOMENTUM ON A MISS. A strike that misses carries the attacker past their
   target and that overreach is what creates the next opening. Never let a
   fighter miss and snap back to a neutral stance — that reset is the single
   most common failure.
3. NAME THE MOMENT OF CONTACT. A strike that is thrown and then described
   only by its aftermath renders as a limb passing THROUGH the other body —
   the commonest failure there is. Say what touches what, at the instant it
   touches: knuckles on the jaw, shin into the ribs, the shaft across the
   forearm, and the snap of the head or the fold of the body that the contact
   produces. "He hits her hard" is not contact; "his elbow catches her cheek
   and her head turns with it" is.
4. CONTACT WITH THE WORLD, in three stages: body, then the thing it hits, then
   what that thing does (a rail bends, plaster cracks, glass goes). Name the
   fixture from the location, never invent one.
5. A WEAPON LIVES IN THE HANDS THAT HOLD IT. Write it as something being
   gripped and swung, never as an accessory someone has: "both hands choked up
   on the staff, driving the butt end forward", not "she attacks with her
   staff". An object described passively is treated as inessential detail and
   quietly stops existing between shots — measured here as a temple staff that
   became a mop head halfway through a block.
6. ONE TECHNIQUE, NOT A COMPOUND ONE. "A fast roundhouse kick" holds together;
   "an explosive spinning jumping reverse kick" pushes past what the model can
   track and the body distorts mid-motion. If a move needs three adjectives to
   describe, it needs a simpler move.
7. FALLS HAVE A PATH. Someone going down travels: the hit, the stagger, what
   they catch at, then the floor. Not a cut to someone lying down.
8. KEEP IT MOVING. A lock, a clinch, a trapped weapon or a test of strength
   is a real beat and it is worth ONE shot, at most two in a row. Three
   consecutive shots in which nobody strikes, nobody travels and nothing
   changes position is not tension, it is two people holding still — the
   "they just grab each other" failure, measured twice. If a hold has to run
   longer than a shot, break it: a grip slips, one fighter gives ground, a
   knee goes in, someone is driven into something. Every shot moves a body.
9. MANY AGAINST ONE, when the scene has one lead and several opponents: they
   arrive ONE AT A TIME and each entrance is caused by what just happened (the
   first is down, so the second has to come around him). Say which side of the
   frame each comes from. Never have them attack simultaneously.
10. ACTION BEFORE SPEECH. If a shot has both a strike and a spoken line, the
   strike must be complete before the line begins — write it in that order.
   A line in the middle of a strike makes the whole shot play slow.

FORBIDDEN: `[Shot N]`, `<Subject N>`, `<Picture N>`, timestamps, camera
direction (the camera is already chosen — do not restate or change it),
trigger words or tag tokens of any kind, new characters, new locations, and
any weapon or object the shot does not already name.

ALSO FORBIDDEN: repeating a character's appearance. You are shown each
fighter's identity line so you know who is who — never paste it into the
action. Hair, eyes, build, clothing and jewellery are declared once, elsewhere,
and every word of them you copy into a shot is a word of choreography that
shot no longer has. Write "she" and "he" and their names; describe only what
the bodies DO.

ALSO FORBIDDEN: saying an object is NOT there. "no spear is visible", "not a
blade", "there is no rack" — these name the thing and put it in the render.
The model has no way to subtract, so a denial is an instruction. Describe what
IS in frame, in enough detail that the wrong object has no room: not "no spear
is visible" but "a plain hardwood shaft, brass-capped at both ends".

Return ONLY JSON:
{"scenes":[{"slug":"SCENE-SLUG","shots":[{"idx":0,"action":"..."}]}]}
`idx` is the shot's position in the scene, from 0. Return every shot of every
scene you are given, in order. Keep each action under 90 words, and well under
that on a short shot — roughly 12-18 words of action per SECOND of shot is
already dense."""


# What a fight shot has to CONTAIN to be a fight rather than a description of
# one. These are the author's own physics vocabulary, and they are the check
# rather than the prompt — the model agrees with "write consequences" and then
# writes "they fight", which is the same lesson dialogue style and camera
# monoculture already taught here.
_IMPACT_WORDS = (
    "stagger", "stumble", "reel", "buckle", "fold", "double over", "drop",
    "knock", "slam", "crash", "collide", "sprawl", "topple", "crumple",
    "recoil", "snap back", "whip", "wrench", "twist", "give way", "collapse",
    "land", "connect", "catch", "grab", "trap", "hook", "shove", "drive",
    "slip", "duck", "block", "parry", "deflect", "counter", "throw", "sweep",
    "takedown", "grapple", "pin", "wince", "gasp", "spit", "bleed", "limp",
)
# A fight described as an event rather than as movement. Any of these in an
# action shot is the failure the whole stage exists to prevent.
_SUMMARY_PHRASES = (
    "they fight", "a fight breaks out", "a brawl", "exchange blows",
    "trade blows", "trading blows", "fight ensues", "fighting ensues",
    "a struggle ensues", "they brawl", "chaos erupts", "all hell",
    "a flurry of", "fists fly", "fighting breaks out", "they battle",
    "a fierce fight", "an intense fight", "they clash",
)
# DO NOT IMPORT THE "WIND-UP / IMPACT / REACTION AS THREE CLIPS" RULE. It is
# standard advice for single-clip generators (Seedance's own fight guide says
# it in as many words: "separate the impact into its own clip", "generate three
# separate clips and edit them together"), and it is correct THERE because such
# a tool renders one prompt with no shot list and no memory. Here it is exactly
# the defect the constants below exist to catch: our compiler emits each shot
# as its own timestamped instruction inside one render, and a chained block is
# told the preceding actions are already finished — so a strike wound up in one
# shot and landed in the next is performed twice, or not at all. Take that
# guide's IMPACT LANGUAGE (rule 3) and its WEAPON phrasing (rule 5); leave its
# clip-splitting where it belongs.
#
# AN ACTION LEFT IN PROGRESS AT THE END OF A SHOT IS NEVER PERFORMED. Each
# shot compiles to its own timestamped instruction, and a chained block is told
# outright that "the actions already performed there are finished and are not
# repeated" — so a movement still travelling when the shot ends falls into the
# gap and neither shot does it. MEASURED on TEMPLE DUEL: the disarm was written
# as "the staff begins to slide free of her grip" at the end of one block and
# "the staff comes away in his hands" at the start of the next; on screen the
# staff simply appears on the floor, with no moment of him taking it. The
# mirror failure is the same defect read forwards — a kick thrown in one shot
# and landed on a pillar in the next came back as two pillar kicks.
_UNFINISHED_TAILS = (
    "begins to", "begin to", "starts to", "start to", "starting to",
    "beginning to", "is about to", "are about to", "about to", "moves to",
)
# …and the completion half, judged on the OPENING of the next shot.
# "instead of" and "rather than" belong here for the same reason: a shot that
# opens by saying where a strike landed INSTEAD of its target is resolving an
# aim that was declared in a previous shot. TEMPLE DUEL b4 threw a spinning
# heel at Ren in shot 0 and opened shot 1 with "Lian's heel smashes the pillar
# instead of Ren" — one kick, written as two, rendered as two.
_COMPLETION_OPENERS = (
    "completes", "completes the", "finishes", "finishing", "finally",
    "follows through", "carries through", "lands the", "the same ",
    "instead of", "rather than",
)
_OPENER_FRACTION = 0.4      # how far into the prose an opener still counts

# A HOLD is a real beat and three in a row is two people standing still — the
# "they just grab each other" complaint, twice. A shot counts as a hold when it
# has lock vocabulary and NO strike: b6 of TEMPLE DUEL ran "pinning it flat
# against the timber" -> "the shaft does not move" -> "peels her fingers off
# the shaft", i.e. 8.25s of a 13.75s block in which nothing travelled, and six
# of ten sampled frames are the identical face-to-face push.
_HOLD_WORDS = (
    "pin", "pins", "pinned", "pinning", "trap", "traps", "trapped",
    "lock", "locks", "locked", "clinch", "grapple", "grip", "grips",
    "gripping", "hold", "holds", "holding", "strain", "straining",
    "haul", "hauls", "hauling", "wrestle", "wrestling", "does not move",
    "will not move", "cannot draw", "both hands", "press", "presses",
    "pressing", "clamp", "clamped", "tug", "tugs", "test of strength",
)
_STRIKE_WORDS = (
    "strike", "strikes", "punch", "punches", "kick", "kicks", "elbow",
    "elbows", "knee", "knees", "palm", "chop", "slam", "slams", "smash",
    "smashes", "crack", "cracks", "hammer", "sweep", "sweeps", "throw",
    "throws", "hurl", "hurls", "headbutt", "blow", "shove", "shoves",
    "knock", "knocks", "stomp", "jab", "swing", "swings", "whip", "whips",
    "lash", "thrust", "thrusts", "takedown", "tackle", "tackles", "slash",
    "drives her", "drives him", "drives the",
)
# A DENIAL NAMES THE THING. "no spear is visible" was written into a real shot
# to keep polearms out of a temple weapon rack, and the render came back with
# polearms on the rack — the same rule `image_prompt` already states for the
# image families ("these models cannot subtract"), reaching the fight prose.
# Only TERMINAL negations are measured to work on H3, and an action shot's
# prose is never terminal: it is one field inside a compiled envelope.
_NEGATED_OBJECT = re.compile(
    r"\bno\s+\w+(?:\s+\w+)?\s+(?:is|are)\s+(?:visible|present|shown|in\s+frame)\b"
    r"|\bthere\s+(?:is|are)\s+no\s+\w+"
    r"|\bnot\s+a\s+\w+\b"
    r"|\bwithout\s+(?:a|any)\s+\w+", re.I)
MAX_HOLD_RUN = 2            # consecutive shots that may pass without a strike
MIN_IMPACT_SHOTS = 0.6      # of a scene's shots must carry physical consequence
# How far into a shot's action prose a quoted line must start for the strike to
# count as finished first. Measured against real output: the correct phrasing
# ("Only after pinning her does he demand, …") puts the quote in the last
# quarter, while a line interrupting a strike lands in the first half.
LINE_TAIL_FRACTION = 0.55
# A shot carrying BOTH a strike and a spoken line needs room for the strike to
# finish first. Measured on the first real r2v fight block: a 3.3s shot holding
# a five-phase chain plus a line rendered as a generic clinch AND dropped the
# line entirely (reviewer: DIALOGUE_MISSING, 0% of the words spoken). Ordering
# the prose is necessary and not sufficient — the shot has to be long enough.
DIALOGUE_ROOM_MS = 4000
# NO DETERMINISTIC OVERPACKING CHECK, DELIBERATELY. The diagnosis is solid —
# 2.7s mean per shot carrying multi-phase chains rendered as a clinch — but
# both candidate metrics misclassify on the very data that motivated them:
# words/sec is inflated by the identity-line boilerplate the cinematographer
# repeats into each action (the offending shot was 152 words of which ~100 were
# identity, i.e. ~15 words/sec of actual action, inside any sane threshold),
# and impact-verb count flags the shot that rendered WELL (4 impacts in 3.8s)
# as readily as the one that failed (5 in 3.3s). One observation is not enough
# to calibrate either, and a threshold that fires on correct prose is worse
# than none — that is exactly the false positive the ACTION-BEFORE-SPEECH check
# had to be rewritten for. The rule is carried by the CONTRACT ("one decisive
# action per shot, the chain runs shot to shot, scale to the seconds you are
# given") until there is enough measured output to calibrate a check.


def _has(text, words):
    low = " " + " ".join((text or "").lower().split()) + " "
    return [w for w in words if w in low]


def fight_scenes(story):
    """The scenes this stage owns: type == action, and they have shots."""
    return [s for s in (story.get("scenes") or [])
            if str(s.get("type") or "").lower() == "action"]


def fight_issues(story, shots_by_slug):
    """Deterministic complaints about the choreography -> re-ask instructions.

    Pure, and phrased as instructions rather than diagnostics, because that is
    what a batched re-ask can act on. Same shape as `dialogue_issues`.
    """
    out = []
    for scene in fight_scenes(story):
        slug = scene.get("slug")
        shots = shots_by_slug.get(slug) or []
        if not shots:
            continue
        summaries = []
        no_impact = []
        for i, sh in enumerate(shots):
            act = sh.get("action") or ""
            hit = _has(act, _SUMMARY_PHRASES)
            if hit:
                summaries.append((i, hit[0]))
            elif not _has(act, _IMPACT_WORDS):
                no_impact.append(i)
        if summaries:
            out.append(
                f"{slug}: shot(s) {', '.join(str(i) for i, _ in summaries)} "
                f"SUMMARISE the fight instead of choreographing it (e.g. "
                f"\"{summaries[0][1]}\"). Replace each with who moves first, "
                f"what they do, where it lands, and how the other reacts.")
        if len(shots) - len(no_impact) < MIN_IMPACT_SHOTS * len(shots):
            out.append(
                f"{slug}: {len(no_impact)} of {len(shots)} shots describe no "
                f"physical consequence — no landing, no reaction, no loss of "
                f"balance. A fight is what the hits DO to the bodies; give "
                f"shots {', '.join(str(i) for i in no_impact[:6])} a "
                f"consequence that persists into the next shot.")
        # A SHOT THAT DOES NOT FINISH ITS OWN ACTION. Both halves of the same
        # defect: a move still travelling when the shot ends is performed by
        # nobody, and a shot that opens by completing the previous one makes
        # the model perform the whole thing twice.
        for i, sh in enumerate(shots):
            act = (sh.get("action") or "").strip()
            if not act:
                continue
            tail = re.split(r"(?<=[.!?])\s+", act)[-1].lower()
            hit = next((t for t in _UNFINISHED_TAILS if t in tail), None)
            if hit:
                out.append(
                    f"{slug} shot {i}: the action ends with something still in "
                    f"progress (\"{hit}\"). Each shot is rendered on its own and "
                    f"the next one is told this shot already finished, so a "
                    f"movement left travelling here is performed by neither. "
                    f"Carry it to where it ends up inside this shot.")
                break
        for i, sh in enumerate(shots[1:], start=1):
            act = (sh.get("action") or "").strip()
            head = act[:max(24, int(_OPENER_FRACTION * len(act)))].lower()
            hit = next((t for t in _COMPLETION_OPENERS if t in head), None)
            if hit:
                out.append(
                    f"{slug} shot {i}: the action opens by completing what shot "
                    f"{i - 1} started (\"{hit}\"). Shots do not know about each "
                    f"other, so the strike is thrown in one and landed in the "
                    f"next and the model performs it TWICE. Put the whole "
                    f"movement in one shot; this one may inherit the STATE it "
                    f"left behind, not finish the movement itself.")
                break

        # A DENIED OBJECT. See _NEGATED_OBJECT.
        for i, sh in enumerate(shots):
            m = _NEGATED_OBJECT.search(sh.get("action") or "")
            if m:
                out.append(
                    f"{slug} shot {i}: \"{m.group(0)}\" tells the render what is "
                    f"NOT there, which names it and puts it in the frame — the "
                    f"model cannot subtract. Delete the denial and describe "
                    f"what IS there in enough detail that the wrong object has "
                    f"no room.")
                break

        # A HOLD RUN — a lock nobody breaks out of. See _HOLD_WORDS.
        run, worst = [], []
        for i, sh in enumerate(shots):
            act = sh.get("action") or ""
            if _has(act, _HOLD_WORDS) and not _has(act, _STRIKE_WORDS):
                run.append(i)
                if len(run) > len(worst):
                    worst = list(run)
            else:
                run = []
        if len(worst) > MAX_HOLD_RUN:
            out.append(
                f"{slug}: shots {', '.join(str(i) for i in worst)} are "
                f"{len(worst)} in a row in which nobody strikes and nothing "
                f"travels — a lock, a grip or a test of strength held across "
                f"the whole run. That reads on screen as two people standing "
                f"still holding each other. Keep at most "
                f"{MAX_HOLD_RUN} and break the rest: a grip slips, one gives "
                f"ground, a knee goes in, someone is driven into something.")

        # Many-against-one: staggered entrances, stated per the contract.
        cast = [c for c in (scene.get("cast") or [])]
        if len(cast) >= 3:
            joined = " ".join((sh.get("action") or "") for sh in shots).lower()
            if not any(w in joined for w in
                       ("first", "second", "third", "next", "then", "behind",
                        "from her", "from his", "one at a time", "while the")):
                out.append(
                    f"{slug}: {len(cast)} people are in this fight and nothing "
                    f"says in what ORDER they engage. Stagger the entrances — "
                    f"each attacker arrives because of what just happened — and "
                    f"say which side of the frame each comes from.")
        # Action before speech, within one shot — the author's measured rule.
        #
        # THE CHECK IS ON ORDER, NOT CO-OCCURRENCE, and that distinction was
        # found by running this live. Flagging any shot that has both a strike
        # and a line fires on the CORRECT prose too ("Only after pinning her
        # does he demand, …"), so it could never be satisfied: a re-ask every
        # run, a permanent non-zero issue count, and a warning nobody reads.
        #
        # So: only judge a shot whose action actually QUOTES the line, where
        # the position is knowable. The line has to sit in the last stretch of
        # the prose, i.e. after the strike has been carried to its end. A shot
        # whose action does not quote the line says nothing about ordering and
        # is left alone rather than guessed at.
        for i, sh in enumerate(shots):
            act = sh.get("action") or ""
            if not (act and _has(act, _IMPACT_WORDS)):
                continue
            early = None
            for d in (sh.get("dialogue") or []):
                line = ((d or {}).get("line") or "").strip().strip('"“”')
                if len(line) < 8:
                    continue
                at = act.find(line[:24])
                if at >= 0 and at < LINE_TAIL_FRACTION * len(act):
                    early = line
                    break
            if early:
                out.append(
                    f"{slug} shot {i}: the spoken line \"{early[:40]}\" starts "
                    f"before the strike in this shot has finished. Carry the "
                    f"attack through to its end FIRST and put the line after "
                    f"it — a line in the middle of a strike makes the whole "
                    f"shot play in slow motion.")
                break

        # A strike and a line in a shot too short to hold both.
        for i, sh in enumerate(shots):
            dur = int(sh.get("duration_ms") or 0)
            act = sh.get("action") or ""
            if (sh.get("dialogue") and 0 < dur < DIALOGUE_ROOM_MS
                    and _has(act, _IMPACT_WORDS)):
                out.append(
                    f"{slug} shot {i}: only {dur/1000:.1f}s for both a strike "
                    f"and a spoken line. There is not room for the attack to "
                    f"finish before the line starts, and the line is what gets "
                    f"dropped — put the strike here and the line in an adjacent "
                    f"shot that is not carrying an impact.")
                break
    return out


def choreographer_messages(story, shots_by_slug):
    """What the choreographer is shown: the ACTION scenes and nothing else.

    Deliberately not the whole script — a fight is local, and handing over the
    quiet scenes invites rewriting them. The camera IS included, read-only, so
    the action it writes can be seen by the shot that was chosen.
    """
    world = (story.get("world") or {})
    who = {c.get("name"): (c.get("identity_line") or c.get("description") or "")
           for c in (story.get("characters") or [])}
    payload = []
    for scene in fight_scenes(story):
        slug = scene.get("slug")
        shots = shots_by_slug.get(slug) or []
        payload.append({
            "slug": slug,
            "location": scene.get("environment") or scene.get("location"),
            "purpose": scene.get("purpose"),
            "emotion_in": scene.get("emotion_in"),
            "emotion_out": scene.get("emotion_out"),
            "cast": scene.get("cast"),
            "geography": (scene.get("blocking") or {}).get("map"),
            "shots": [{
                "idx": i,
                "camera": sh.get("camera"),
                "action": sh.get("action"),
                "duration_ms": sh.get("duration_ms"),
                "dialogue": [(d or {}).get("line") for d in (sh.get("dialogue") or [])],
            } for i, sh in enumerate(shots)],
        })
    return [{"role": "user", "content": json.dumps({
        "world": {"era": world.get("era"), "tone": world.get("tone")},
        "characters": who,
        "action_scenes": payload,
    }, ensure_ascii=False)}]


def strip_identity_lines(text, identities):
    """Drop a character's IDENTITY LINE out of an action shot.

    The choreographer is shown `characters: {name: identity_line}` so it knows
    who is who, and it routinely pastes those lines back into the prose it
    returns — verbatim. MEASURED on RIVALS: all 29 shots opened with the full
    wardrobe description of both fighters, ~90 words of hair, eyes, build and
    jewellery per shot, leaving 25-35 words of actual action inside a 3-second
    beat.

    That is pure dilution and it is also redundant: `h3_prompt` declares every
    subject ONCE at the top of the envelope in `subject_definitions`, from
    these same strings. Repeating them inside `[Shot N]` buys nothing and
    pushes the technique, the contact and the reaction down into the tail of a
    long paragraph — the "the framing clause is 2% of a 350-word prompt"
    failure that the panel work already measured from the other side.

    Deterministic, not another re-ask: the pasted text is byte-identical to
    the bible line, so a match is exact rather than a judgement. Sentences are
    dropped whole; anything that is not a recognised identity line is left
    alone.
    """
    out = str(text or "")
    for line in identities:
        line = (line or "").strip()
        if len(line) < 40:            # too short to be an identity line
            continue
        for variant in (line, line.rstrip(".") + ".", line.rstrip(".")):
            out = out.replace(variant, " ")
    return re.sub(r"\s{2,}", " ", out).strip()


def apply_choreography(story, shots_by_slug, data):
    """Merge the choreographer's rewritten action back -> (applied, skipped).

    Only `action`, only on scenes this stage was given, only where the shot
    exists and the text is non-trivial. Same defensive shape as
    `merge_voice_pass`: a stage that drifts is DROPPED rather than allowed to
    break the shot list it was handed.
    """
    owned = {s.get("slug") for s in fight_scenes(story)}
    _ids = [c.get("identity_line") or c.get("description") or ""
            for c in (story.get("characters") or [])]
    applied = skipped = 0
    for sc in ((data or {}).get("scenes") or []):
        slug = sc.get("slug")
        if slug not in owned:
            skipped += 1
            continue
        shots = shots_by_slug.get(slug) or []
        for sh in (sc.get("shots") or []):
            try:
                i = int(sh.get("idx"))
            except (TypeError, ValueError):
                skipped += 1
                continue
            act = (sh.get("action") or "").strip()
            if not (0 <= i < len(shots)) or len(act) < 20:
                skipped += 1
                continue
            # A rewrite that drops most of the shot is a summary, not
            # choreography — the exact failure this stage exists to fix.
            old = shots[i].get("action") or ""
            if old and len(act.split()) < 0.5 * len(old.split()):
                skipped += 1
                continue
            act = strip_identity_lines(act, _ids)
            if len(act) < 20:         # it was ONLY boilerplate
                skipped += 1
                continue
            shots[i]["action"] = act
            applied += 1
    return applied, skipped


def composer_messages(story, *, medium=None, music_note=None):
    """What the composer is shown: the world, what each character WANTS, and
    every scene in order with its emotional turn and its length.

    Deliberately NOT the dialogue or the shot list. A composer scoring to
    picture works from the shape of the thing — where it turns, where it holds
    — and a full script in the window invites writing about a line rather than
    about the film. Durations ARE included, because "where does it withhold"
    is a question about time.

    `music_note` is the writer's own one-to-three-sentence `music` field: the
    seed this stage exists to elaborate rather than replace.
    """
    doc = {
        "title": story.get("title"),
        "medium": medium,
        "world": {k: (story.get("world") or {}).get(k)
                  for k in ("era", "technology", "palette", "motifs",
                            "style_notes")
                  if (story.get("world") or {}).get(k)},
        "characters": [{k: c.get(k) for k in ("name", "role", "want")
                        if c.get(k)}
                       for c in story.get("characters") or []],
        "scenes": [{"slug": s.get("slug"), "purpose": s.get("purpose"),
                    "conflict": s.get("conflict"),
                    "emotion_in": s.get("emotion_in"),
                    "emotion_out": s.get("emotion_out"),
                    "type": s.get("type"),
                    "duration_ms": s.get("duration_ms")}
                   for s in story.get("scenes") or []],
    }
    if music_note:
        doc["writers_music_note"] = music_note
    return [{"role": "user", "content": json.dumps(doc, ensure_ascii=False)}]


# The cue scale the contract states, and the only place it is interpreted.
MAX_INTENSITY = 5


def normalize_score(data, story):
    """The composer's artifact, made safe to compile and to mix from.

    Two duties, both of which fail silently if skipped. The caption compiler
    is tolerant of missing fields but not of a `bpm` of "seventy-two"; and the
    MIX reads `cues` by SLUG — `assemble_cut` builds a per-scene gain envelope
    from them — so a cue naming a scene that does not exist is a gain change
    applied nowhere, and a scene with no cue would silently take whatever the
    envelope's default is. Every scene therefore gets a cue, in story order,
    invented at the middle of the scale where the composer left one out.
    """
    score = dict(((data or {}).get("score") or data or {}))
    score.pop("cues", None)
    raw_cues = ((data or {}).get("score") or {}).get("cues") or (data or {}).get("cues") or []

    try:
        score["bpm"] = int(round(float(score.get("bpm"))))
    except (TypeError, ValueError):
        score.pop("bpm", None)
    if not isinstance(score.get("instruments"), list):
        score["instruments"] = [x.strip() for x in
                                str(score.get("instruments") or "").split(",")
                                if x.strip()]

    by_slug = {}
    for c in raw_cues:
        if not isinstance(c, dict):
            continue
        slug = str(c.get("scene") or c.get("slug") or "").strip().upper()
        if not slug:
            continue
        try:
            inten = int(round(float(c.get("intensity"))))
        except (TypeError, ValueError):
            inten = 3
        by_slug[slug] = {"scene": slug,
                         "intent": str(c.get("intent") or "").strip()[:180],
                         "intensity": max(0, min(MAX_INTENSITY, inten))}

    cues, unknown = [], sorted(set(by_slug) - {s.get("slug") for s in
                                              story.get("scenes") or []})
    for s in story.get("scenes") or []:
        slug = s.get("slug")
        cues.append(by_slug.get(slug) or {"scene": slug, "intent": "", "intensity": 3})
    score["cues"] = cues
    if unknown:
        score["unmatched_cues"] = unknown
    return score


def character_messages(story, name):
    """The script as one character sees it: their profile, and every beat
    they speak in with the surrounding lines visible but marked immutable."""
    prof = next((c for c in story.get("characters") or []
                 if (c.get("name") or "").strip().lower() == name.lower()), {})
    scenes = []
    for s in story.get("scenes") or []:
        beats = []
        for i, b in enumerate(s.get("beats") or []):
            dlg = b.get("dialogue") or []
            if not any((d.get("speaker") or "").strip().lower() == name.lower()
                       for d in dlg):
                continue
            beats.append({"idx": i, "label": b.get("label"),
                          "action": b.get("action"),
                          "dialogue": [{"speaker": d.get("speaker"),
                                        "line": d.get("line"),
                                        "delivery": d.get("delivery"),
                                        "mine": ((d.get("speaker") or "").strip().lower()
                                                 == name.lower())}
                                       for d in dlg]})
        if beats:
            scenes.append({"slug": s["slug"], "purpose": s.get("purpose"),
                           "conflict": s.get("conflict"), "beats": beats})
    doc = {"rewrite_only": name,
           "character": {k: prof.get(k) for k in
                         ("name", "personality", "speech_pattern", "want",
                          "role", "identity_line") if prof.get(k)},
           "scenes": scenes}
    return [{"role": "user", "content": json.dumps(doc, ensure_ascii=False)}]


def merge_character_pass(story, data, name):
    """Fold a per-character rewrite back in, replacing only that character's
    lines. Defensive in the same way as merge_voice_pass: a beat is applied
    only when the rewrite returns that speaker's lines in the same count and
    within the length bounds the shot timing depends on."""
    changed = 0
    low = name.strip().lower()
    by_slug = {s["slug"]: s for s in story.get("scenes") or []}
    for sc in (data or {}).get("scenes") or []:
        scene = by_slug.get(str(sc.get("slug") or "").strip().upper())
        if not scene:
            continue
        beats = scene.get("beats") or []
        for rb in sc.get("beats") or []:
            try:
                idx = int(rb.get("idx"))
            except (TypeError, ValueError):
                continue
            if not 0 <= idx < len(beats):
                continue
            old_all = beats[idx].get("dialogue") or []
            mine_pos = [j for j, d in enumerate(old_all)
                        if (d.get("speaker") or "").strip().lower() == low]
            new = [d for d in (rb.get("dialogue") or [])
                   if isinstance(d, dict) and d.get("line")
                   and (d.get("speaker") or "").strip().lower() == low]
            if not mine_pos or len(new) != len(mine_pos):
                continue
            ok = all(abs(words(n["line"]) - words(old_all[j].get("line"))) <=
                     max(3, int(words(old_all[j].get("line")) * 0.4))
                     for n, j in zip(new, mine_pos))
            if not ok:
                continue
            for n, j in zip(new, mine_pos):
                if n["line"].strip() != (old_all[j].get("line") or "").strip():
                    changed += 1
                old_all[j]["line"] = n["line"]
                if n.get("delivery"):
                    old_all[j]["delivery"] = n["delivery"]
    return changed


# ------------------------------------------------- continuity / blocking ----
def blocking_messages(story):
    doc = {
        "environments": [{"name": e["name"], "features": (e.get("features") or []),
                          "scale": e.get("scale")}
                         for e in story.get("environments") or []],
        "scenes": [{"slug": s["slug"], "environment": s.get("environment"),
                    "cast": s.get("cast") or [], "purpose": s.get("purpose"),
                    "entrances": s.get("entrances"), "type": s.get("type"),
                    "beats": [{"idx": i, "label": b.get("label"),
                               "action": b.get("action"),
                               "speakers": sorted({(d.get("speaker") or "").strip()
                                                   for d in b.get("dialogue") or []
                                                   if d.get("speaker")})}
                              for i, b in enumerate(s.get("beats") or [])]}
                   for s in story["scenes"]],
    }
    return [{"role": "user", "content": json.dumps(doc, ensure_ascii=False)}]


# `"doing":"exits":true` — the model reaching for the enters/exits flag and
# collapsing it into the preceding value. Measured twice on AFTERLIGHT E3, at
# the first character to leave a scene in both runs. One occurrence is a syntax
# error at char ~4000 of a 15KB document, so the WHOLE artifact fails to parse
# and all ten scenes lose their blocking — which is how the Continuity Director
# silently did nothing. Rewritten to `"doing":"exits","exits":true`: keeps the
# prose value and gives blocking_states the flag it actually reads.
_STRANDED_FLAG = re.compile(r'("(?:at|facing|doing)"\s*:\s*"(enters|exits)")\s*:\s*(true|false)')


def _salvage_scenes(text):
    """Per-scene objects pulled out of an unparseable artifact.

    `normalize_blocking` promises "garbage in a scene drops that scene's
    blocking, never the pass", and it cannot keep that promise when the parse
    that feeds it is all-or-nothing. Brace-match each `{"slug": …}` and parse
    them one at a time, so a malformation the repair above doesn't know about
    costs one scene instead of ten.
    """
    out = []
    for m in re.finditer(r'\{\s*"slug"\s*:', text):
        depth, start, in_str, esc = 0, m.start(), False, False
        for i in range(start, len(text)):
            c = text[i]
            if esc:
                esc = False
                continue
            if c == "\\":
                esc = True
            elif c == '"':
                in_str = not in_str
            elif not in_str:
                if c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        try:
                            out.append(json.loads(text[start:i + 1]))
                        except json.JSONDecodeError:
                            pass
                        break
    return out


def parse_blocking(text, json_repair):
    """Blocking artifact text -> {slug: {...}}, as forgivingly as is safe.

    Three escalating steps, each measured against a real failure: parse it;
    repair the stranded enters/exits flag and parse again; failing that, keep
    whatever individual scenes are well-formed. Returns {} only when nothing at
    all survives — and the caller says so out loud.
    """
    for candidate in (text, _STRANDED_FLAG.sub(r'\1,"\2":\3', text)):
        try:
            return normalize_blocking(json_repair(candidate))
        except Exception:  # noqa: BLE001 — every failure falls to the next step
            continue
    fixed = _STRANDED_FLAG.sub(r'\1,"\2":\3', text)
    scenes = _salvage_scenes(fixed)
    return normalize_blocking({"scenes": scenes}) if scenes else {}


def normalize_blocking(data):
    """{slug: {map, start, beats}} from the blocking artifact; garbage in a
    scene drops that scene's blocking, never the pass."""
    out = {}
    for sc in (data or {}).get("scenes") or []:
        slug = str(sc.get("slug") or "").strip().upper()
        if not slug:
            continue
        start = {str(k): v for k, v in (sc.get("start") or {}).items()
                 if isinstance(v, dict)}
        beats = []
        for b in sc.get("beats") or []:
            try:
                idx = int(b.get("idx"))
            except (TypeError, ValueError):
                continue
            changes = {str(k): v for k, v in (b.get("changes") or {}).items()
                       if isinstance(v, dict)}
            if changes:
                beats.append({"idx": idx, "changes": changes})
        if start or beats:
            out[slug] = {"map": str(sc.get("map") or "").strip() or None,
                         "start": start, "beats": beats}
    return out


def blocking_states(blocking, n_beats):
    """The maintained state graph: per-beat {name: {at, facing, doing}},
    start + cumulative changes. `enters` adds a body, `exits` removes it —
    a character who exited holds no position and can hold no line. Pure."""
    state = {nm: {k: v for k, v in st.items() if k in ("at", "facing", "doing")}
             for nm, st in (blocking.get("start") or {}).items()}
    changes_at = {b["idx"]: b["changes"] for b in blocking.get("beats") or []}
    out = []
    for i in range(n_beats):
        for nm, ch in (changes_at.get(i) or {}).items():
            if ch.get("exits"):
                state.pop(nm, None)
                continue
            cur = state.setdefault(nm, {})
            for k in ("at", "facing", "doing"):
                if ch.get(k):
                    cur[k] = ch[k]
        out.append({nm: dict(st) for nm, st in state.items()})
    return out


def blocking_issues(scene, blocking):
    """Deterministic contradictions in one scene's blocking — phrased as
    re-ask instructions. Pure."""
    issues = []
    n = len(scene.get("beats") or [])
    states = blocking_states(blocking, n)
    tracked = set(blocking.get("start") or {})
    for b in blocking.get("beats") or []:
        for nm, ch in b["changes"].items():
            if ch.get("enters"):
                tracked.add(nm)
    for nm in scene.get("cast") or []:
        if nm not in tracked:
            issues.append(f"{nm} is in the scene's cast but has no start "
                          f"position and never enters")
    for i, b in enumerate(scene.get("beats") or []):
        speakers = {(d.get("speaker") or "").strip()
                    for d in b.get("dialogue") or [] if d.get("speaker")}
        for sp in speakers:
            if sp in tracked and sp not in states[i]:
                issues.append(f"{sp} speaks in beat {i} ('{b.get('label')}') "
                              f"but has exited / not yet entered there")
    return issues


def position_text(st):
    """One state entry -> the spatial sentence fragment the compiler states
    per shot ('at the teller cage, facing Mika, seated'). Pure."""
    bits = []
    if st.get("at"):
        at = str(st["at"]).strip()
        bits.append(at if re.match(r"^(at|in|on|by|under|behind|beside|near)\b",
                                   at, re.I) else f"at {at}")
    if st.get("facing"):
        bits.append(f"facing {st['facing']}")
    if st.get("doing") and str(st["doing"]).lower() not in ("standing",):
        bits.append(str(st["doing"]))
    return ", ".join(bits)


def apply_blocking_positions(scene, shots, blocking):
    """The state graph overrides shot positions for everyone it tracks —
    the cinematographer chose the camera, never the geography. The cine's
    own positions survive only for characters the blocking doesn't know."""
    n = len(scene.get("beats") or [])
    if not n:
        return shots
    states = blocking_states(blocking, n)
    for sh in shots:
        bi = min(sh.get("beat_idx", 0), n - 1)
        state = states[bi]
        pos = dict(sh.get("positions") or {})
        for nm in sh.get("cast") or []:
            if nm in state:
                txt = position_text(state[nm])
                if txt:
                    pos[nm] = txt
        if pos:
            sh["positions"] = pos
    return shots


# --------------------------------------------------------- duplicate cast ---
def duplicate_cast(story):
    """Pairs (keep, drop) of character entries that are the same person —
    exact-normalized name matches and token-subset names ('Mika' vs 'Mika
    Chen'). Two bible entries for one person means two faces on screen.

    AMBIGUITY IS NOT A DUPLICATE, and this is a mechanical DELETE, not a hint:
    the dropped character loses her entry, her sheets, her lines are reassigned
    and nothing on screen says so. Measured on a real episode whose cast was
    `Rei`, `Guide Rei`, `Knight Rei`, `Villian Rei` and `Astronaut` — five
    deliberate versions of one person, which is the premise of the show. Bare
    token-subset made `Rei` a duplicate of whichever Rei happened to come first
    in the list, so the PROTAGONIST was silently merged into her own guide and
    the cast came back as four.

    A name contained in exactly one other is the case this was written for
    ('Mika' / 'Mika Chen'); a name contained in three is a family, and no
    reading of it can tell you which one it duplicates. The test has to hold
    for BOTH sides of the pair: 'Guide Rei' contains only 'Rei' and looks
    unambiguous from where it stands, while 'Rei' sits inside three others —
    so checking one side merges exactly the pair it should refuse. Exact
    matches are unaffected; those are not ambiguous at all.
    """
    def toks(name):
        return frozenset(re.sub(r"[^a-z0-9 ]+", "", str(name).lower()).split())

    everyone = [c for c in (story.get("characters") or []) if toks(c["name"])]

    def relatives(t):
        return [a for a in everyone
                if toks(a["name"]) != t and (t < toks(a["name"]) or toks(a["name"]) < t)]

    pairs, alive = [], []
    for c in everyone:
        t = toks(c["name"])
        dup = next((a for a in alive if toks(a["name"]) == t), None)
        if dup is None and len(relatives(t)) == 1:
            cand = next((a for a in alive
                         if t < toks(a["name"]) or toks(a["name"]) < t), None)
            if cand is not None and len(relatives(toks(cand["name"]))) == 1:
                dup = cand
        if dup is None:
            alive.append(c)
            continue

        def _weight(x):
            return (len(str(x.get("identity_line") or "")), len(toks(x["name"])))

        keep, drop = (dup, c) if _weight(dup) >= _weight(c) else (c, dup)
        pairs.append((keep["name"], drop["name"]))
        if keep is not dup:
            alive[alive.index(dup)] = c
    return pairs


def merge_duplicate_cast(story):
    """Apply duplicate_cast mechanically: one entry survives, every scene
    cast list and every spoken line follows it. Returns merged pair count."""
    pairs = duplicate_cast(story)
    for keep, drop in pairs:
        story["characters"] = [c for c in story["characters"] if c["name"] != drop]
        for sc in story.get("scenes") or []:
            sc["cast"] = list(dict.fromkeys(
                keep if nm == drop else nm for nm in (sc.get("cast") or [])))
            for b in sc.get("beats") or []:
                for d in b.get("dialogue") or []:
                    if (d.get("speaker") or "").strip() == drop:
                        d["speaker"] = keep
    return len(pairs)


def cine_messages(story, scene_slugs=None, revision_note=""):
    """What the DP is shown. `revision_note` is the director's note for a
    re-plan, and withholding it here was a hole in the pipeline rather than a
    simplification: a note is routinely half CAMERA DIRECTION ("a POV shot",
    "she flies past camera", "it zooms in on the city in her eye") and the only
    stage that had ever seen one was the WRITER — whose contract forbids camera
    language outright, so the instruction was handed to the one department told
    to ignore it and kept from the one that decides it.

    Measured on the first real re-plan: "miko picks up helmet and looks at
    astronaut (pov shot)" came back a high-angle static medium, and "villian
    fly past camera" came back a tracking wide. Both are shots the DP can
    obviously deliver; it was never asked."""
    doc = {
        "world": story.get("world"),
        "characters": [{"name": c["name"], "identity_line": c.get("identity_line"),
                        "role": c.get("role")} for c in story.get("characters") or []],
        "scenes": [s for s in story["scenes"]
                   if scene_slugs is None or s["slug"] in scene_slugs],
    }
    msgs = [{"role": "user", "content": json.dumps(doc, ensure_ascii=False)}]
    if str(revision_note or "").strip():
        msgs.append({"role": "user", "content":
                     "The director's note for this revision, which the writer "
                     "worked from:\n\n" + str(revision_note).strip() +
                     "\n\nThe story above is locked — do not add or remove "
                     "events. But where this note names a SHOT (a POV, a move "
                     "past camera, a zoom or push, an angle, what is in frame), "
                     "that is a camera instruction addressed to you, and the "
                     "beat it belongs to must be covered exactly that way. "
                     "Where the note describes a run of distinct actions, give "
                     "each its own shot rather than compressing them."})
    return msgs


def repair_request(story, shots_by_slug, issues_by_slug):
    """One batched re-ask covering every offending scene."""
    lines = []
    for slug, issues in issues_by_slug.items():
        for i in issues:
            lines.append(f"- {slug}: {i}")
    doc = {"scenes": [{"slug": slug, "shots": shots_by_slug[slug]}
                      for slug in issues_by_slug]}
    return [{"role": "user", "content":
             "Your shot lists for these scenes have problems:\n" + "\n".join(lines) +
             "\n\nHere is what you sent:\n" + json.dumps(doc, ensure_ascii=False) +
             "\n\nResend ONLY these scenes, fixed, in the same JSON shape."}]


# --------------------------------------------------------------- pipeline ---
def run_pipeline(*, brief_json, treatment, ask, note, target_ms,
                 skip_editor=False, revision_note="", medium=None,
                 want_score=True, comedy=False):
    """Run writer → editor → cinematographer over injected `ask`.

    ask(stage, system_suffix, messages, max_tokens) -> text
    note(stage_label) -> None (progress reporting)

    Returns (story, shots_by_slug, editor_notes)."""
    from llm import json_repair  # local import: llm imports this module too

    note("Writer: story structure")
    text = ask("writer", WRITER_CONTRACT, writer_messages(brief_json, treatment), 16000)
    try:
        story = normalize_story(json_repair(text))
    except Exception as e:  # noqa: BLE001 — one repair attempt
        note(f"Writer: repairing ({str(e)[:60]})")
        text = ask("writer", WRITER_CONTRACT,
                   writer_messages(brief_json, treatment) + [
                       {"role": "assistant", "content": text[:12000]},
                       {"role": "user", "content":
                           f"That was invalid ({str(e)[:120]}). Reply with ONLY the "
                           f"corrected complete JSON object."}], 16000)
        story = normalize_story(json_repair(text))

    editor_notes = []
    if not skip_editor:
        note("Story editor: dramatic pass")
        try:
            etext = ask("editor", EDITOR_CONTRACT, editor_messages(story), 16000)
            edited = json_repair(etext)
            editor_notes = [n for n in (edited.get("notes") or []) if isinstance(n, dict)]
            if isinstance(edited.get("revised"), dict):
                story = normalize_story(edited["revised"])
        except Exception as e:  # noqa: BLE001 — the editor is advisory
            note(f"Story editor: skipped ({str(e)[:60]})")

    # Cast completeness runs AFTER the editor: its revision replaces the whole
    # story object, so anyone added earlier would be silently dropped. Every
    # on-screen name gets a full character (a supporting player without an
    # identity line renders with a different face every block).
    missing = missing_cast(story)
    if missing:
        note(f"Writer: describing {len(missing)} unnamed cast")
        text2 = ask("writer", WRITER_CONTRACT, [
            {"role": "user", "content":
                json.dumps({"characters": story["characters"],
                            "scenes_excerpt": [
                                {"slug": s["slug"], "cast": s.get("cast"),
                                 "purpose": s.get("purpose")}
                                for s in story["scenes"]]}, ensure_ascii=False)},
            {"role": "user", "content":
                "These people appear on screen or speak but are not in characters[]: "
                + ", ".join(missing) +
                '. Return ONLY {"characters": [...]} — one full character object '
                "(role supporting or extra, complete identity_line, voice) for each."}],
            4000)
        try:
            extra = json_repair(text2).get("characters") or []
            have = {c["name"].strip().lower() for c in story["characters"]}
            for c in extra:
                if c.get("name") and c["name"].strip().lower() not in have:
                    c.setdefault("role", "supporting")
                    story["characters"].append(c)
        except Exception:  # noqa: BLE001 — stubs beat a dead plan
            pass
        for name in missing_cast(story):
            story["characters"].append({
                "name": name, "role": "extra", "summary": "background figure",
                "identity_line": f"{name}, an incidental figure whose look stays "
                                 f"consistent with the world's era and palette"})

    # One person, one entry: 'Mika' and 'Mika Chen' as separate characters
    # means two face sheets and two faces on screen. Mechanical, runs after
    # cast completeness so the stubs it just added are deduped too.
    n_merged = merge_duplicate_cast(story)
    if n_merged:
        note(f"Continuity: merged {n_merged} duplicate character(s)")

    # Location completeness — cast completeness's twin, same shape: one
    # batched re-ask, then a mechanical fallback so the guarantee is absolute.
    # A scene that reaches the planner without a resolvable environment binds
    # to no bible entry, stages no location reference, and gets no plate
    # rotation; see missing_locations for the measured case.
    unlocated = missing_locations(story)
    if unlocated:
        note(f"Writer: locating {len(unlocated)} scene(s)")
        text3 = ask("writer", WRITER_CONTRACT, [
            {"role": "user", "content": json.dumps(
                {"environments": [e.get("name")
                                  for e in story.get("environments") or []],
                 "scenes": [{"slug": m["slug"], "named": m["environment"],
                             "purpose": next(
                                 (s.get("purpose") for s in story["scenes"]
                                  if s.get("slug") == m["slug"]), None)}
                            for m in unlocated]}, ensure_ascii=False)},
            {"role": "user", "content":
                "These scenes name no environment from environments[]: "
                + ", ".join(str(m["slug"]) for m in unlocated) +
                '. Reply ONLY {"scene_environments": {"<slug>": "<environment '
                'name>"}, "environments": [...]} — pick an existing '
                "environment where one fits, and include a full environment "
                "object (name, scale, features, light_sources, identity_line) "
                "for any new place you name."}], 4000)
        try:
            got = json_repair(text3)
            have = {(e.get("name") or "").strip().lower()
                    for e in story.get("environments") or []}
            for e in got.get("environments") or []:
                nm = (e.get("name") or "").strip()
                if nm and nm.lower() not in have:
                    story.setdefault("environments", []).append(e)
                    have.add(nm.lower())
            assign = {str(k).strip().lower(): str(v).strip()
                      for k, v in (got.get("scene_environments") or {}).items()
                      if v}
            for s in story["scenes"]:
                nm = assign.get(str(s.get("slug") or "").strip().lower())
                # Only bind a name the model actually defined or that already
                # exists — an assignment to a place nobody described falls
                # through to the mechanical fallback instead.
                if nm and nm.lower() in have \
                        and (s.get("environment") or "").strip().lower() not in have:
                    s["environment"] = nm
        except Exception:  # noqa: BLE001 — the fallback below still binds
            pass
        for m in missing_locations(story):
            s = next((x for x in story["scenes"] if x.get("slug") == m["slug"]),
                     None)
            if s is None:
                continue
            env = fallback_location(s)
            # Two scenes can want the same unlisted name; one entry serves both.
            if env["name"].strip().lower() not in {
                    (e.get("name") or "").strip().lower()
                    for e in story.get("environments") or []}:
                story.setdefault("environments", []).append(env)
            s["environment"] = env["name"]

    # Dialogue polish AFTER cast completeness (every speaker now has a
    # personality to write against) and BEFORE the cinematographer (lines are
    # placed into shots downstream, and shot floors are computed from the
    # final words). Advisory: a failure keeps the writer's lines.
    if any(b.get("dialogue") for s in story["scenes"] for b in s.get("beats") or []):
        note("Dialogue pass: sharpening voices")
        try:
            vtext = ask("voice", VOICE_CONTRACT, voice_messages(story), 12000)
            n_changed = merge_voice_pass(story, json_repair(vtext))
            if n_changed:
                note(f"Dialogue pass: {n_changed} line(s) sharpened")
        except Exception as e:  # noqa: BLE001 — the writer's lines stand
            note(f"Dialogue pass: skipped ({str(e)[:60]})")

        # Per-character passes. One writer voicing four people in one call
        # produces one voice wearing four hats — measured on E2, where the
        # only axis that differentiated was line LENGTH (Haru 3.9 words, Ren
        # 10.7) while the content tics never landed. Each call sees one
        # character's profile and only their lines as mutable, so there is
        # nothing to average toward. Cheap: a few thousand tokens each.
        speakers = {}
        for s in story["scenes"]:
            for b in s.get("beats") or []:
                for d in b.get("dialogue") or []:
                    nm = (d.get("speaker") or "").strip()
                    if nm:
                        speakers[nm] = speakers.get(nm, 0) + 1
        ranked = [nm for nm, n in sorted(speakers.items(), key=lambda kv: -kv[1])
                  if n >= 2][:6]
        for nm in ranked:
            try:
                ctext = ask("character", CHARACTER_VOICE_CONTRACT,
                            character_messages(story, nm), 8000)
                n_c = merge_character_pass(story, json_repair(ctext), nm)
                if n_c:
                    note(f"Voice of {nm}: {n_c} line(s) rewritten")
            except Exception as e:  # noqa: BLE001 — one voice failing keeps the rest
                note(f"Voice of {nm}: skipped ({str(e)[:40]})")

        # Deterministic style validation, then ONE batched re-ask — the same
        # shape as blocking and camera coverage. The contract already asks for
        # interruptions and trailing off in plain language; E2 came back
        # 91-100% complete sentences anyway. An LLM agrees with a style rule
        # and then writes clean prose; only a check changes that.
        probs = dialogue_issues(story)
        if probs:
            note(f"Dialogue: {len(probs)} style issue(s) — revising")
            try:
                rtext = ask("voice", VOICE_CONTRACT, voice_messages(story) + [
                    {"role": "user", "content":
                        "These specific failures are in the script as it "
                        "stands:\n" + "\n".join(f"- {p}" for p in probs) +
                        "\n\nFix exactly these. Resend ONLY the beats you "
                        "change, same JSON shape. Same speakers, same line "
                        "counts, same intent per line."}], 10000)
                n_fix = merge_voice_pass(story, json_repair(rtext))
                left = dialogue_issues(story)
                note(f"Dialogue: {n_fix} line(s) revised, "
                     f"{len(probs) - len(left)} issue(s) resolved")
            except Exception as e:  # noqa: BLE001 — advisory, never a gate
                note(f"Dialogue revision skipped ({str(e)[:60]})")

        # PUNCH-UP: comedy only, and LAST of the dialogue stages — it is the
        # pass that wants finished lines to sharpen, exactly as a room does it.
        # Same advisory contract as every other rewrite stage: a failure leaves
        # the voice pass's lines, which is what every episode before this
        # rendered from.
        if comedy:
            note("Punch-up: comedy pass")
            try:
                ptext = ask("punchup", PUNCHUP_CONTRACT, punchup_messages(story), 12000)
                n_p = merge_voice_pass(story, json_repair(ptext))
                note(f"Punch-up: {n_p} line(s) sharpened")
            except Exception as e:  # noqa: BLE001 — the voice pass's lines stand
                note(f"Punch-up: skipped ({str(e)[:60]})")
            cprobs = comedy_issues(story)
            if cprobs:
                note(f"Punch-up: {len(cprobs)} comedy issue(s) — revising")
                try:
                    ctext2 = ask("punchup", PUNCHUP_CONTRACT,
                                 punchup_messages(story) + [
                                     {"role": "user", "content":
                                      "These specific failures are in the "
                                      "script as it stands:\n"
                                      + "\n".join(f"- {p}" for p in cprobs) +
                                      "\n\nFix exactly these. Resend ONLY the "
                                      "beats you change, same JSON shape. Same "
                                      "speakers, same line counts."}], 10000)
                    n_c2 = merge_voice_pass(story, json_repair(ctext2))
                    cleft = comedy_issues(story)
                    note(f"Punch-up: {n_c2} line(s) revised, "
                         f"{len(cprobs) - len(cleft)} issue(s) resolved")
                except Exception as e:  # noqa: BLE001 — advisory
                    note(f"Punch-up revision skipped ({str(e)[:60]})")

    # Blocking BEFORE the cinematographer: the continuity director fixes the
    # geography (positions, facing, entrances per beat), the DP then chooses
    # only cameras against it. Advisory-but-validated: a scene whose blocking
    # contradicts itself gets one batched re-ask, then drops its blocking
    # (the cine's own positions stand) rather than shipping a broken map.
    blocking_by_slug = {}
    note("Continuity: blocking the scenes")
    try:
        btext = ask("blocking", BLOCKING_CONTRACT, blocking_messages(story), 12000)
        blocking_by_slug = parse_blocking(btext, json_repair)
        # A pass that parses to NOTHING used to be indistinguishable from a
        # pass that worked: `bad` stays empty, no scene gets `blocking`, and
        # the only two notes this stage can emit are "revising N" and
        # "skipped (exception)" — neither fires. Measured on AFTERLIGHT E3: ten
        # scenes, zero blocking, and the progress log read exactly like a clean
        # run. `normalize_blocking` wants {"scenes": [{slug, start, beats}]} and
        # returns {} for any other shape, so this is the likeliest way the
        # Continuity Director silently doesn't happen.
        if not blocking_by_slug:
            note("Continuity: blocking produced nothing usable — "
                 f"cameras stand on their own (got {btext[:80]!r})")
        bad = {}
        for s in story["scenes"]:
            bl = blocking_by_slug.get(s["slug"])
            if bl:
                probs = blocking_issues(s, bl)
                if probs:
                    bad[s["slug"]] = probs
        if bad:
            note(f"Continuity: revising {len(bad)} scene(s) of blocking")
            lines = [f"- {slug}: {p}" for slug, ps in bad.items() for p in ps]
            rtext = ask("blocking", BLOCKING_CONTRACT, blocking_messages(story) + [
                {"role": "assistant", "content": btext[:12000]},
                {"role": "user", "content":
                    "Your blocking for these scenes contradicts the script:\n"
                    + "\n".join(lines) +
                    "\n\nResend ONLY these scenes, fixed, same JSON shape."}], 8000)
            fixed = normalize_blocking(json_repair(rtext))
            for slug in bad:
                if slug in fixed and not blocking_issues(
                        next(s for s in story["scenes"] if s["slug"] == slug),
                        fixed[slug]):
                    blocking_by_slug[slug] = fixed[slug]
                else:
                    blocking_by_slug.pop(slug, None)
        for s in story["scenes"]:
            if s["slug"] in blocking_by_slug:
                s["blocking"] = blocking_by_slug[s["slug"]]
    except Exception as e:  # noqa: BLE001 — blocking is scaffolding, not a gate
        note(f"Continuity: blocking skipped ({str(e)[:60]})")
        blocking_by_slug = {}

    note("Cinematographer: planning coverage")
    shots_by_slug = {}
    slugs = [s["slug"] for s in story["scenes"]]
    for i in range(0, len(slugs), 8):
        batch = slugs[i:i + 8]
        if i:
            note(f"Cinematographer: scenes {i + 1}-{i + len(batch)}")
        ctext = ask("cinematographer", CINE_CONTRACT,
                    cine_messages(story, set(batch), revision_note), 16000)
        try:
            part = normalize_shots(json_repair(ctext), {
                **story, "scenes": [s for s in story["scenes"] if s["slug"] in batch]})
        except Exception:  # noqa: BLE001 — degrade to one-shot-per-beat
            part = normalize_shots({}, {
                **story, "scenes": [s for s in story["scenes"] if s["slug"] in batch]})
        shots_by_slug.update(part)

    # ---- validate coverage; one batched re-ask, then mechanical floors ------
    issues = {}
    scene_by_slug = {s["slug"]: s for s in story["scenes"]}
    for slug, shots in shots_by_slug.items():
        probs = scene_shot_issues(scene_by_slug[slug], shots)
        if probs:
            issues[slug] = probs
    if issues:
        note(f"Cinematographer: revising {len(issues)} scene(s)")
        try:
            rtext = ask("cinematographer", CINE_CONTRACT,
                        cine_messages(story, set(issues), revision_note) +
                        repair_request(story, shots_by_slug, issues), 16000)
            fixed = normalize_shots(json_repair(rtext), {
                **story, "scenes": [s for s in story["scenes"] if s["slug"] in issues]})
            for slug, shots in fixed.items():
                if shots:
                    shots_by_slug[slug] = shots
        except Exception:  # noqa: BLE001 — the mechanical floor still applies
            pass
    for slug, shots in shots_by_slug.items():
        shots = enforce_min_shots(scene_by_slug[slug], shots)
        # A COMEDY CUTS ON THE LAUGH, so it gets no breath shot. The pause
        # exists because drama scenes were cutting straight out of a spoken
        # line into the next location and reading as rushed — but in a sitcom
        # the button IS the exit, and a held wordless beat after it is the one
        # thing that reliably kills a joke. Measured on the first sitcom
        # planned here: `comedy_issues` passed the script (every scene ended on
        # its hardest line) and then all ELEVEN scenes ended on a 1.75s wordless
        # hold anyway, because the breath was appended AFTER the check ran.
        # The packer's rule that a block may not end on a speaking beat still
        # holds — it simply cuts earlier, which is what a sitcom does anyway.
        if not comedy:
            shots = add_breath_shot(scene_by_slug[slug], shots)
        shots_by_slug[slug] = shots
        # The state graph has the last word on where people are: derived
        # positions (at + facing + posture) overwrite the DP's for everyone
        # the blocking tracks, on every shot — including the mechanical
        # splits above, which inherit their source shot's beat.
        if slug in blocking_by_slug:
            apply_blocking_positions(scene_by_slug[slug], shots_by_slug[slug],
                                     blocking_by_slug[slug])

    fit_shot_durations([{**scene_by_slug[slug], "shots": shots_by_slug[slug]}
                        for slug in [s["slug"] for s in story["scenes"]]], target_ms)
    # fit mutated copies of the scene dicts; re-sum onto the real ones
    for s in story["scenes"]:
        s["duration_ms"] = sum(sh["duration_ms"] for sh in shots_by_slug[s["slug"]])

    # ---- the fight choreographer -------------------------------------------
    #
    # After the cinematographer (the shots and cameras it writes against have
    # to exist) and after blocking (the geography it stages the fight in).
    # ACTION scenes only — a fight is local, and handing over the quiet scenes
    # invites rewriting them.
    #
    # Advisory, like the editor and the dialogue polish: a failure leaves the
    # writer's own action prose in place, which is exactly what every episode
    # before this one rendered from. It does NOT touch durations, so it is
    # safe either side of fit_shot_durations.
    _fights = fight_scenes(story)
    if _fights:
        note(f"Choreographer: {len(_fights)} action scene(s)")
        try:
            ftext = ask("choreographer", CHOREOGRAPHER_CONTRACT,
                        choreographer_messages(story, shots_by_slug), 12000)
            applied, skipped = apply_choreography(
                story, shots_by_slug, json_repair(ftext))
            note(f"Choreographer: {applied} shot(s) rewritten"
                 + (f", {skipped} dropped" if skipped else ""))
            # The check is the point, not the contract. A model agrees with
            # "write consequences, never summarise" and then writes "they
            # fight" — the same lesson dialogue style and camera monoculture
            # already taught here. ONE batched re-ask, then the prose stands.
            issues = fight_issues(story, shots_by_slug)
            if issues:
                note(f"Choreographer: re-asking ({len(issues)} issue(s))")
                rtext = ask("choreographer", CHOREOGRAPHER_CONTRACT,
                            choreographer_messages(story, shots_by_slug) + [
                                {"role": "user", "content":
                                 "Your previous pass has these problems. Fix "
                                 "every one and return the SAME JSON shape:\n- "
                                 + "\n- ".join(issues)}], 12000)
                a2, s2 = apply_choreography(story, shots_by_slug,
                                            json_repair(rtext))
                left = fight_issues(story, shots_by_slug)
                note(f"Choreographer: {a2} shot(s) revised, "
                     f"{len(left)} issue(s) remaining")
        except Exception as e:  # noqa: BLE001 — the writer's action prose stands
            note(f"Choreographer: skipped ({str(e)[:60]})")

    # ---- the composer ------------------------------------------------------
    #
    # LAST, and after the durations are final: the contract asks where the
    # score withholds, which is a question about time, and scene lengths are
    # not settled until fit_shot_durations has run. Advisory like the editor
    # and the dialogue polish — a failure leaves `story["score"]` unset and
    # the music job falls back to the writer's own one-line `music` field,
    # which is exactly what every score before this one was built from.
    if want_score:
        note("Composer: the score bible")
        try:
            stext = ask("composer", COMPOSER_CONTRACT,
                        composer_messages(story, medium=medium,
                                          music_note=story.get("music")), 4000)
            score = normalize_score(json_repair(stext), story)
            if score.get("instruments") or score.get("idiom"):
                story["score"] = score
                silent = sum(1 for c in score["cues"] if c["intensity"] == 0)
                note(f"Composer: {score.get('idiom') or 'score'} — "
                     f"{len(score.get('instruments') or [])} instrument(s), "
                     f"{len(score['cues'])} cue(s)"
                     + (f", {silent} silent" if silent else ""))
            else:
                note("Composer: skipped (no usable score returned)")
        except Exception as e:  # noqa: BLE001 — the writer's music note stands
            note(f"Composer: skipped ({str(e)[:60]})")

    return story, shots_by_slug, editor_notes

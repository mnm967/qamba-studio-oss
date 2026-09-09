"""Shot contracts: the ground truth a take is judged against.

Not prose — data, and not authored by an LLM: the storyboard already IS the
contract (shots, cast, dialogue, timing, environment, time of day). This
module just projects it into the flat structure the analyzers and the VLM
judge consume, so "did the take satisfy the plan" is a comparison against
fields, not an inference from a scene description.

Pure functions over dicts (no DB access) — testable off-pod. The worker
builds a contract at review time from the same rows master_pass compiled
from, so the two can never drift.
"""
import re

import vocal_events as VE

# H3 performs lines slowly — pauses, breath, reaction beats ride inside
# the utterance. 2.4 w/s matched read-aloud pace, not generated pace, and
# lines kept running out of shot (both takes of block 1).
WORDS_PER_SEC = 2.0
LINE_PAD_MS = 1200


def _words(text):
    return re.findall(r"[\w'’-]+", str(text or ""))


def build_contract(*, block, beats, cast, environment, scenes, project=None,
                   world=None, props=None):
    """block/beats/cast/environment/scenes: the same rows _load_context gives
    master_pass (beats ordered). `world` is the writer's world bible (the
    storyboard doc's `world`) — its vfx_language rides into the contract so
    the judge can hold every spell/effect to ONE design grammar. Returns the
    TakeContract dict."""
    content_ms = int(block["t_end_ms"]) - int(block["t_start_ms"])
    shots, dialogue, t = [], [], 0
    for i, b in enumerate(beats):
        dur = int(b["duration_ms"])
        cast_names = [n for n in ((b.get("meta") or {}).get("cast") or [])]
        positions = (b.get("meta") or {}).get("positions") or {}
        shots.append({
            "shot": i + 1,
            "t0_ms": t, "t1_ms": t + dur,
            "camera": b.get("camera"),
            "action": b.get("action"),
            "cast": cast_names,
            **({"positions": positions} if positions else {}),
            "beat": ((b.get("meta") or {}).get("beat") or {}).get("label"),
        })
        for d in (b.get("dialogue") or []):
            # "(sigh) It's good…" is performed as a sigh and then the words;
            # the ASR hears no "sigh", so the expected line is the words.
            line = VE.strip_events(d.get("line") or "")
            need = int(len(_words(line)) / WORDS_PER_SEC * 1000) + LINE_PAD_MS
            dialogue.append({
                "shot": i + 1,
                "speaker": (d.get("speaker") or "").split(" — ")[0].strip(),
                "line": line,
                "window_ms": [t, t + dur],
                "min_ms": need,
                # A deliberate V.O. cutaway: the judge must not fault the
                # speaker for being out of frame while this line plays.
                **({"offscreen": True} if d.get("offscreen") else {}),
            })
        t += dur
    scene_meta = (scenes[0].get("meta") or {}) if scenes else {}
    return {
        "block_idx": block.get("idx"),
        "content_ms": content_ms,
        "characters": [{"name": c["name"].split(" — ")[0].strip(),
                        "identity_line": c.get("identity_line") or c.get("summary")}
                       for c in cast],
        "environment": ({"name": environment.get("name"),
                         "identity_line": environment.get("identity_line")
                                          or environment.get("summary")}
                        if environment else None),
        "time_of_day": scene_meta.get("time"),
        "scene_type": scene_meta.get("type"),
        "purpose": scene_meta.get("purpose"),
        # The continuity director's stable scene map — what left/right/
        # opposite mean in this room. The judge holds observed geography to
        # it the same way it holds shots to `positions`.
        "geography": (scene_meta.get("blocking") or {}).get("map"),
        "chained": bool(block.get("chain_from_block_id")),
        "shots": shots,
        "dialogue": dialogue,
        "style": (project or {}).get("style"),
        "vfx_language": (world or {}).get("vfx_language"),
        # The designed object list (same source as the compile's equipment
        # line) — what PROP_MISMATCH is judged against.
        "props": [p.get("name") for p in (props or []) if p.get("name")] or None,
    }


def expected_transcript(contract):
    """The dialogue as one ordered list of expected utterances."""
    return [d["line"] for d in contract.get("dialogue") or []]


# --------------------------------------------------------- dialogue compare --
# Contractions expand on BOTH sides of the comparison: the script writes
# "I'm buying her name back", the ASR writes "I am …" (or the reverse), and
# token equality sees two different words where one was spoken.
_CONTRACTIONS = {
    "i'm": "i am", "i've": "i have", "i'll": "i will", "i'd": "i would",
    "you're": "you are", "you've": "you have", "you'll": "you will",
    "we're": "we are", "we've": "we have", "we'll": "we will",
    "they're": "they are", "they've": "they have", "they'll": "they will",
    "he's": "he is", "she's": "she is", "it's": "it is", "that's": "that is",
    "there's": "there is", "what's": "what is", "who's": "who is",
    "don't": "do not", "doesn't": "does not", "didn't": "did not",
    "can't": "cannot", "won't": "will not", "wouldn't": "would not",
    "couldn't": "could not", "shouldn't": "should not", "isn't": "is not",
    "aren't": "are not", "wasn't": "was not", "weren't": "were not",
    "haven't": "have not", "hasn't": "has not", "hadn't": "had not",
    "let's": "let us", "ain't": "is not",
}


def _norm(text):
    toks = re.sub(r"[^a-z0-9' ]+", " ", str(text or "").lower()).split()
    out = []
    for t in toks:
        out.extend(_CONTRACTIONS.get(t, t).split())
    return out


_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven",
         "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen",
         "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
         "eighty", "ninety"]


def _num_words(n):
    """0..999999 -> spoken words. Written lines say numbers in words; the ASR
    writes digits — without this bridge a perfectly spoken money line scores
    0% coverage (live: '200,000 keeps her contracted' vs the contract's 'two
    hundred thousand…' burned a retake on a line that was fine)."""
    if n < 20:
        return [_ONES[n]]
    if n < 100:
        t, r = divmod(n, 10)
        return [_TENS[t]] + ([_ONES[r]] if r else [])
    if n < 1000:
        h, r = divmod(n, 100)
        return [_ONES[h], "hundred"] + (_num_words(r) if r else [])
    t, r = divmod(n, 1000)
    return _num_words(t) + ["thousand"] + (_num_words(r) if r else [])


def _expand_digits(tok):
    """One stream token -> the word sequence a script would write. '200,000'
    -> ['two','hundred','thousand']; '2.5' -> ['two','point','five'];
    '$250' -> ['two','hundred','fifty']; non-numeric tokens pass through."""
    t = tok.lstrip("$€£").replace(",", "")
    # Hyphenated pairs: the script's "fifty-fifty" / "sixty-forty" arrives
    # as '50-50' / '60-40' (measured live on every one of Dex's odds lines).
    if re.fullmatch(r"\d{1,3}(-\d{1,3})+", t):
        out = []
        for part in t.split("-"):
            out += _num_words(int(part))
        return out
    if not t or not re.fullmatch(r"\d+(\.\d+)?%?", t):
        return [tok]
    out = []
    pct = t.endswith("%")
    if pct:
        t = t[:-1]
    if "." in t:
        whole, frac = t.split(".", 1)
        out += _num_words(min(int(whole or 0), 999999)) + ["point"]
        out += [_ONES[int(d)] for d in frac[:4]]
    else:
        out += _num_words(min(int(t), 999999))
    if pct:
        out.append("percent")
    # Spoken tens-pairs collapse into one 4-digit token ("sixty-forty" ->
    # '4060', measured live on an odds line). Append the pair reading as
    # alternative pieces — the gap-tolerant matcher skips whichever reading
    # the line doesn't use.
    if re.fullmatch(r"\d{4}", t):
        a, b = int(t[:2]), int(t[2:])
        if a >= 10 and b >= 10:
            out += _num_words(a) + _num_words(b)
    return out


def spine_fractions(spine_lines, t0_ms, t1_ms):
    """How much of each spine line lives INSIDE [t0_ms, t1_ms) -> {norm: frac}.

    A dialogue-spine block's audio is one continuous recording, and a line
    whose tail crosses the block's end COMPLETES IN THE NEXT BLOCK — the
    design's graceful case, seamless in the assembled episode. The reviewer's
    contract gives the OWNING block the whole line, so it measured that case
    as DIALOGUE_CUTOFF and queued an auto-retake that cannot win: the audio
    is the spine, identical in every take, so the retake measures the
    identical "cutoff" and is discarded — pure GPU spend. Measured on THE
    LATE SHIFT b4: "Behind the umbrellas. Red case—" spans 36574..39034
    against a block ending 38784, coverage 0.8 heard, retake fired.

    Keyed by the line's normalized text (what `compare_dialogue` aligns on).
    Only fractions meaningfully below 1 are returned — a line fully inside
    its block keeps the ordinary scoring. Pure.
    """
    out = {}
    for l in spine_lines or []:
        t0, t1 = int(l.get("t0_ms") or 0), int(l.get("t1_ms") or 0)
        if t1 <= t0 or t1 <= t0_ms or t0 >= t1_ms:
            continue
        frac = (min(t1, t1_ms) - max(t0, t0_ms)) / (t1 - t0)
        if frac < 0.98:
            key = " ".join(_norm(l.get("line") or ""))
            if key:
                out[key] = round(frac, 3)
    return out


def compare_dialogue(contract, asr_words, spine_frac=None):
    """Expected lines vs ASR word stream -> issues.

    asr_words: [{word, start (s), end (s)}] from the transcriber. Word-level
    greedy alignment per line: find the line's words in order in the stream
    (allowing gaps), then judge coverage and where the tail landed. This is
    what turns "she got cut off" from a feeling into DIALOGUE_CUTOFF with the
    missing words named.

    `spine_frac` ({normalized line: fraction inside this block}, from
    `spine_fractions`) is the dialogue spine's escape hatch: a line that only
    partly lives in this block is judged against the part that does, and its
    crossing tail is a continuation, not a cutoff.
    """
    # faster-whisper words arrive with LEADING SPACES (" You") — strip
    # whitespace before punctuation or every word mismatches and a perfectly
    # spoken line scores 0% coverage (live block 0 did exactly that). Its
    # WORD tokens also split large numbers at the thousands separators —
    # '$200,000' arrives as '$200' + ',000' (measured live: the fragments
    # expanded to 'two hundred' + 'zero' and a spoken money line scored 18%)
    # — so digit-group continuations merge back into one token first, then
    # digits expand to their spoken words ('250' -> two hundred fifty), each
    # piece sharing the merged token's stamps.
    toks = []
    for w in (asr_words or []):
        raw = str(w.get("word", "")).strip()
        if not raw:
            continue
        # rstrip first: the full strip eats a continuation token's LEADING
        # comma (',000' -> '000') before the merge check can see it.
        lead = raw.lower().rstrip(".,!?…\"'“”")
        base = lead.lstrip(".,!?…\"'“”")
        prev = toks[-1] if toks else None
        if (prev and re.fullmatch(r",\d{3}", lead)
                and re.fullmatch(r"[$€£]?[\d,]+", prev["w"])):
            prev["w"] += lead
            prev["e"] = w["end"]
        elif base:
            toks.append({"w": base, "s": w["start"], "e": w["end"]})
    # Contractions expand on the STREAM side too — the header note always
    # promised "both sides", but only `want` went through _norm, so the ASR's
    # "wasn't" could never equal the script's "was"+"not". Measured live
    # (AFTERLIGHT exchange alignment): one early contraction made the old
    # unbounded scan below consume the whole stream hunting for "was", and
    # every later line then scored 0% — 8/8 "unmatched" on a verbatim take.
    stream = [{"w": piece, "s": t["s"], "e": t["e"]}
              for t in toks
              for p0 in _CONTRACTIONS.get(t["w"], t["w"]).split()
              for piece in _expand_digits(p0)]
    issues, matches = [], []
    cursor = 0
    content_s = (contract.get("content_ms") or 0) / 1000
    # An unheard word is SKIPPED, never chased to the end of the stream: the
    # search window is wide while seeking a line's first word and tight once
    # anchored, so one bad word costs itself, not every line after it. The
    # anchored window is deliberately small — consecutive words of one line
    # are adjacent in speech, and a wider window let a missing word match its
    # twin in the NEXT line instead (6 still covers the tens-pair digit
    # expansion, whose alternative reading sits 4 tokens out).
    WIN_SEEK, WIN_ANCHORED = 40, 6
    for d in contract.get("dialogue") or []:
        want = _norm(d["line"])
        if not want:
            continue
        hit, missed = [], []
        i, j = cursor, 0
        while j < len(want):
            win = WIN_ANCHORED if hit else WIN_SEEK
            k = next((x for x in range(i, min(i + win, len(stream)))
                      if stream[x]["w"] == want[j]
                      or (len(want[j]) > 3 and want[j] in stream[x]["w"])), None)
            if k is None:
                missed.append(want[j])
            else:
                hit.append(stream[k])
                i = k + 1
            j += 1
        coverage = (len(want) - len(missed)) / len(want)
        entry = {"speaker": d["speaker"], "line": d["line"], "coverage": round(coverage, 2)}
        if hit:
            entry["t0"] = round(hit[0]["s"], 2)
            entry["t1"] = round(hit[-1]["e"], 2)
            cursor = max(cursor, i - 1)
        matches.append(entry)
        frac = (spine_frac or {}).get(" ".join(want))
        if frac is not None:
            # The spine put only `frac` of this line inside this block; the
            # rest plays in its neighbour and reconstructs at the join. Judge
            # the words that COULD be here, and never call the crossing tail
            # a cutoff. A shortfall well below the fraction is still real.
            if coverage >= max(0.35, frac - 0.15):
                entry["continues"] = True
                continue
        if coverage < 0.5:
            issues.append({"code": "DIALOGUE_MISSING", "severity": "high",
                           "detail": f'{d["speaker"]}: "{d["line"][:60]}" — only '
                                     f"{int(coverage * 100)}% of the words were spoken"})
        elif coverage < 0.9:
            missing = " ".join(missed)[:60]
            near_end = bool(hit) and content_s - hit[-1]["e"] < 1.0
            issues.append({"code": "DIALOGUE_CUTOFF" if near_end else "DIALOGUE_PARTIAL",
                           "severity": "high" if near_end else "medium",
                           "detail": f'{d["speaker"]}: line ends "{missing}" unspoken'
                                     + (" — trailing words ran past the segment end"
                                        if near_end else "")})
        elif hit and content_s - hit[-1]["e"] < 0.25:
            issues.append({"code": "DIALOGUE_TIGHT_TAIL", "severity": "low",
                           "detail": f'{d["speaker"]}: last word ends '
                                     f"{content_s - hit[-1]['e']:.2f}s before the cut"})
    # words spoken that belong to no expected line — hallucinated dialogue
    if stream and not contract.get("dialogue"):
        spoken = " ".join(w["w"] for w in stream[:20])
        if len(stream) > 6:
            issues.append({"code": "UNSCRIPTED_SPEECH", "severity": "medium",
                           "detail": f'speech in a dialogue-free block: "{spoken[:70]}…"'})
    return matches, issues


def echo_issues(contract, prev_lines, asr_words):
    """Lines from the CHAINED-FROM block found spoken again in this take.

    A measurement, not a vibe: the previous block's closing lines are run
    through the same word-alignment as expected dialogue; one that is not
    also expected HERE but shows ≥70% of its words in order is an echo — the
    chained-continuation failure where H3 re-performs its predecessor's last
    line (in whichever mouth is handy) and squeezes this block's own dialogue
    past the cut. Caught live as the block 8→9 cascade: each take opened with
    the previous block's line and its own line went DIALOGUE_CUTOFF."""
    own = {" ".join(_norm(d.get("line"))) for d in (contract.get("dialogue") or [])}
    issues = []
    for pl in prev_lines or []:
        line = (pl.get("line") or "").strip()
        want = _norm(line)
        if len(want) < 3 or " ".join(want) in own:
            continue
        fake = {"content_ms": contract.get("content_ms"),
                "dialogue": [{"speaker": pl.get("speaker") or "?", "line": line}]}
        m, _ = compare_dialogue(fake, asr_words)
        if m and m[0]["coverage"] >= 0.7:
            issues.append({
                "code": "DIALOGUE_ECHO", "severity": "high",
                "detail": f'the preceding block\'s line "{line[:60]}" is spoken '
                          f"again in this take ({int(m[0]['coverage'] * 100)}% of "
                          f"its words, at {m[0].get('t0', '?')}s)"})
    return issues


# ------------------------------------------------------------------ scoring --
SEVERITY_WEIGHT = {"high": 0.35, "medium": 0.15, "low": 0.05}

# Issue code -> score category it damages.
CATEGORY = {
    "DIALOGUE_CUTOFF": "dialogue", "DIALOGUE_MISSING": "dialogue",
    "DIALOGUE_PARTIAL": "dialogue", "DIALOGUE_TIGHT_TAIL": "dialogue",
    "UNSCRIPTED_SPEECH": "dialogue", "DIALOGUE_ORDER": "dialogue",
    "DIALOGUE_ECHO": "dialogue", "WRONG_SPEAKER": "dialogue",
    "SPEAKER_SUSPECT": "dialogue",
    "SILENT_TAKE": "audio", "CLIPPING": "audio", "LONG_SILENCE": "audio",
    "MISSING_CHARACTER": "continuity", "EXTRA_CHARACTER": "continuity",
    "DUPLICATE_CHARACTER": "continuity", "WRONG_INTERACTION": "continuity",
    "WRONG_ENVIRONMENT": "continuity", "WRONG_TIME_OF_DAY": "continuity",
    "IDENTITY_DRIFT": "continuity", "WARDROBE_MISMATCH": "continuity",
    "REPEATED_ACTION": "continuity", "GEOGRAPHY_BREAK": "continuity",
    "PROP_MISMATCH": "continuity",
    "ACTION_FLAT": "action",
    "ACTION_MISMATCH": "action", "COVERAGE_MISSING": "action",
    "CAMERA_MISMATCH": "camera",
    "VISUAL_ARTIFACT": "quality", "FROZEN_FRAMES": "quality",
    "BLACK_FRAMES": "quality", "TEXT_GIBBERISH": "quality",
}

HARD_CODES = {"DIALOGUE_CUTOFF", "DIALOGUE_MISSING", "MISSING_CHARACTER",
              "WRONG_ENVIRONMENT", "WRONG_TIME_OF_DAY", "SILENT_TAKE",
              "BLACK_FRAMES", "FROZEN_FRAMES", "DUPLICATE_CHARACTER",
              "DIALOGUE_ECHO", "WRONG_SPEAKER"}


# A hard code the judge left no directive for still gets a corrective
# sentence — a retake should never re-roll blind against a known defect.
RETAKE_DIRECTIVES = {
    "WRONG_ENVIRONMENT": "Every shot takes place inside the declared "
                         "environment — no plain backdrop, no other location.",
    "WRONG_TIME_OF_DAY": "The stated time of day holds for the entire segment; "
                         "the light never changes.",
    "MISSING_CHARACTER": "Every character named in the shots is visibly on "
                         "screen in those shots.",
    "DUPLICATE_CHARACTER": "Each character appears at most once in any frame; "
                           "nobody is doubled or mirrored.",
    "IDENTITY_DRIFT": "Each character's face, hair and outfit stay exactly as "
                      "defined from the first frame to the last.",
    "DIALOGUE_ECHO": "No words spoken in the preceding segment are spoken in "
                     "this one.",
    "WRONG_SPEAKER": "Each line is delivered by exactly the character named "
                     "for it, their mouth visibly forming the words — except "
                     "a line marked `offscreen`, which is deliberate "
                     "voice-over: its speaker plays out of frame and NO "
                     "on-screen mouth forms those words.",
    "PROP_MISMATCH": "No weapon, shield or device beyond those named in the "
                     "description appears in any shot.",
}


def retake_directives(hard):
    """The retake's director's note: the judge's own per-issue `directive`
    first, the deterministic phrase for its code as the fallback — deduped,
    capped to what a prompt can carry."""
    out = []
    for i in hard:
        d = (i.get("directive") or "").strip() or RETAKE_DIRECTIVES.get(i.get("code"))
        if d and d not in out:
            out.append(d)
    return " ".join(out[:3])[:500]


def score(issues):
    """Issues -> per-category scores in [0,1] plus an overall."""
    cats = {"dialogue": 1.0, "audio": 1.0, "continuity": 1.0, "action": 1.0,
            "camera": 1.0, "quality": 1.0}
    for i in issues:
        cat = CATEGORY.get(i.get("code"), "quality")
        cats[cat] = max(0.0, cats[cat] - SEVERITY_WEIGHT.get(i.get("severity"), 0.1))
    cats["overall"] = round(sum(cats.values()) / len(cats), 3)
    return {k: round(v, 3) for k, v in cats.items()}


def verdict(issues, scores):
    """keep / patch / retake, plus why. Patch when damage is local (a single
    ranged issue with a usable remainder); retake on hard failures; keep
    otherwise — low-severity notes ride along as polish items."""
    hard = [i for i in issues if i.get("code") in HARD_CODES]
    if hard:
        ranged = [i for i in hard if i.get("range_ms")]
        if ranged and len(hard) == len(ranged) and scores.get("overall", 0) > 0.6:
            return "patch", hard
        return "retake", hard
    if scores.get("overall", 1) < 0.55:
        return "retake", issues
    return "keep", []

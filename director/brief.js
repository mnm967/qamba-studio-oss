// The one-shot brief — the structured thing the wizard's opening conversation
// is actually for. Plain JS for the same reason personas.js is: imported by
// api/director/* (serverless), by the Vite frontend, and mirrored (merge only)
// in worker/director_tools.py for the local backend.
//
// The interview is an agent turn like any other: the director talks, and every
// fact it establishes lands in `chat_threads.brief` through the `note_brief`
// tool. The wizard renders that row, so the panel under the transcript is the
// model's actual working state — not a client-side guess at what it heard.

/** Fields the panel shows, in the order it shows them. */
export const BRIEF_SECTIONS = [
  { key: "logline", label: "Logline" },
  { key: "premise", label: "Premise" },
  { key: "turn", label: "The turn" },
  { key: "tone", label: "Tone" },
  { key: "palette", label: "Palette & light" },
];

export const EXPERTS = [
  { id: "writing", label: "Writing", tone: "#5aa2ff",
    brief: "story logic, want/obstacle per character, the turn, dialogue intent" },
  { id: "directing", label: "Directing", tone: "#c97aff",
    brief: "shot grammar, coverage, blocking, where the camera lives" },
  { id: "vfx", label: "VFX", tone: "#6fd08c",
    brief: "practical vs. impossible imagery, how effects are staged and lit" },
  { id: "costume", label: "Costume & continuity", tone: "#ffb454",
    brief: "wardrobe pieces, wear and damage, what must match shot to shot" },
  { id: "choreo", label: "Fight choreography", tone: "#ff8080",
    brief: "beats of the action, geography, impacts and reactions" },
  { id: "environment", label: "Environment design", tone: "#4fd2c2",
    brief: "scale, dressing, light, sound and background life of every location" },
];

export const EXPERT_IDS = EXPERTS.map((e) => e.id);
export const expertById = (id) => EXPERTS.find((e) => e.id === id) ?? null;

export const emptyBrief = () => ({});

const clean = (v) => (typeof v === "string" ? v.trim() : "");
const uniq = (list) => {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const s = clean(raw);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
};

const STR_FIELDS = ["title", "logline", "premise", "turn", "tone", "palette", "audience", "ending"];
const LIST_FIELDS = ["motifs", "references", "constraints", "open_questions"];
const PEOPLE = { cast: ["role", "look", "want"], world: ["look", "when"], props: ["look", "why"] };

/** The one list-valued field a named record carries: asset ids of pictures the
 *  user attached FOR this character/place/prop. Kept apart from the prose
 *  fields because it unions rather than overwrites — "here's her face" and
 *  "here's her coat" on two turns are two sheets, not a correction. */
const NAMED_LIST_FIELDS = ["ref_asset_ids"];
/** Loose enough to catch what a model actually sends (some quote-wrap them,
 *  some send the whole `asset:<uuid>` form), strict enough that a label or a
 *  filename never reaches the planner as an id. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const assetIds = (raw) => {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out = [];
  for (const v of list) {
    const hit = UUID_RE.exec(typeof v === "string" ? v : "");
    if (hit && !out.includes(hit[0].toLowerCase())) out.push(hit[0].toLowerCase());
  }
  return out;
};

/** Open questions are gaps, not transcript. Models hand back the whole thing
 *  they just asked — "What kind of excitement? Do you want high-paced action,
 *  a suspenseful moment, or something emotionally intense?" — and the panel
 *  then repeats the line sitting one inch above it. A gap is a few words
 *  ("tone: action or dread"); anything sentence-shaped is the question itself. */
const QUESTION_MAX_CHARS = 60;
const QUESTION_MAX_WORDS = 9;
export const isQuestionStub = (q) =>
  !!q && q.length <= QUESTION_MAX_CHARS
  && q.split(/\s+/).length <= QUESTION_MAX_WORDS
  && q.split(/(?<=[.!?])\s+/).filter(Boolean).length < 2;

/**
 * Open questions are a WORKING SET, not a log, and nothing ever retired them.
 *
 * The model adds a gap most turns and sends `resolved_questions` almost never,
 * so the list only grows: a real interview reached SEVENTY, of which every one
 * had since been answered — "Rei's visual identity" was still open next to a
 * cast entry with an attached reference sheet. That flooded the panel's chip
 * row, and worse, `briefToPlan` hands the list to the planner as "decide these
 * yourself, consistently", so seventy stale instructions rode into the plan.
 *
 * Text dedupe barely dents it (measured: 70 -> 63) because the rewordings are
 * genuinely different — "Rei visual identity", "Rei visual reference", "Rei
 * exact continuity look". So the cap is what does the work, and newest wins:
 * a gap the model raised this turn is live, one from thirty turns ago is not.
 */
export const MAX_OPEN_QUESTIONS = 12;
const tidyQuestions = (list) => {
  const stubs = (list ?? []).map((q) => clean(q).replace(/\s+/g, " ")).filter(isQuestionStub);
  const byKey = new Map();
  for (const q of stubs) byKey.set(nameKey(q) || q.toLowerCase(), q);   // last phrasing wins
  return [...byKey.values()].slice(-MAX_OPEN_QUESTIONS);
};

/** Connectives and intensifiers a stub uses without saying anything about WHAT
 *  it asks. Kept apart from `NOISE_WORDS` deliberately: that set feeds
 *  `nameKey`, which decides whether two CAST ENTRIES are one person, and
 *  widening it there so "tone & palette" matches "tone and palette" would also
 *  merge "Salt and Pepper" into "Salt Pepper". */
const Q_NOISE = new Set(["and", "or", "for", "to", "in", "on", "with", "its", "their",
                         "exact", "concrete", "full", "specific", "what", "which"]);
const questionTokens = (q) =>
  new Set(nameKey(q).split(" ").filter((w) => w && !Q_NOISE.has(w)));

/** Two phrasings of one gap. `resolved_questions` is documented as "exact
 *  text" and models paraphrase anyway — measured, "tone & palette" failed to
 *  retire "tone and palette" and the gap stayed open for the rest of the
 *  interview. Overlap rather than equality. */
const Q_SAME = 0.6;
const sameQuestion = (a, b) => {
  const A = questionTokens(a), B = questionTokens(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared) >= Q_SAME;
};

/** Words that make a stub a question about how something LOOKS, so the thing
 *  it names having a `look` IS the answer to it. */
const LOOK_ASKED = new Set([
  "look", "design", "identity", "visual", "appearance", "silhouette",
  "outfit", "wardrobe", "costume", "sheet", "reference",
]);

/** A stub that names a PART OF THE BRIEF, and the test that part is now filled.
 *  Deliberately narrow. "look" is NOT a tone word here: "hideout look" asks
 *  about the hideout, and retiring it because `tone` is set would drop a real
 *  gap. "who" is not a cast word for the same reason — "who owns the boat" is
 *  not answered by the cast list being non-empty. */
const ANSWERED_BY = [
  { words: ["location", "where", "setting", "environment", "place", "world"],
    ok: (b) => (b.world ?? []).some((w) => clean(w?.name)) },
  { words: ["tone", "palette", "mood", "grade"],
    ok: (b) => !!(clean(b.tone) || clean(b.palette)) },
  { words: ["ending", "end", "outro", "finale"], ok: (b) => !!clean(b.ending) },
  { words: ["turn"], ok: (b) => !!clean(b.turn) },
  { words: ["premise", "story", "logline"], ok: (b) => !!(clean(b.logline) || clean(b.premise)) },
  { words: ["title"], ok: (b) => !!clean(b.title) },
  { words: ["audience"], ok: (b) => !!clean(b.audience) },
  { words: ["length", "duration", "shape", "structure", "section"],
    ok: (b) => !!(b.shape?.length_s || clean(b.shape?.structure) || b.shape?.sections?.length) },
  { words: ["cast", "crew", "character", "protagonist", "hero", "heroine", "lead"],
    ok: (b) => (b.cast ?? []).some((c) => clean(c?.name) && clean(c?.look)) },
  { words: ["song", "track", "lyric", "music"],
    ok: (b) => !!(clean(b.song?.lyrics) || clean(b.song?.style)) },
];

/**
 * Open questions the brief now ANSWERS, retired with no model involved.
 *
 * `resolved_questions` was the only way a gap ever closed, and the model sends
 * it almost never — so the list only grew, and `briefToPlan` hands it to the
 * planner as "decide these yourself, consistently". Measured on a real
 * interview: twelve open questions of which EIGHT were answered in the same
 * document, including "primary location" beside six locations and "protagonist
 * name and look" beside a fully described lead. The planner was being told to
 * invent things the brief states three lines above.
 *
 * Two rules, both exact:
 *  - NAMED — the stub asks how something looks, and every roster entry it
 *    names now has a `look`.
 *  - FIELD — the stub names a part of the brief that is now filled.
 *
 * A question about the look of something that HAS a look retires even when it
 * asks for more precision ("Rei exact continuity look"), and that is the
 * point rather than a wrinkle: five phrasings of that one question is how the
 * seventy-item list was built. The move there is to refine the `look`, not to
 * hold a question about it.
 */
export function answeredQuestions(brief) {
  const b = brief ?? {};
  const open = b.open_questions ?? [];
  if (!open.length) return [];
  const roster = [...(b.cast ?? []), ...(b.world ?? []), ...(b.props ?? [])]
    .filter((x) => clean(x?.name));
  const out = [];
  for (const q of open) {
    const toks = questionTokens(q);
    if (!toks.size) continue;
    if ([...toks].some((w) => LOOK_ASKED.has(w))) {
      const named = roster.filter((x) =>
        nameKey(x.name).split(" ").some((w) => w && toks.has(w)));
      if (named.length && named.every((x) => clean(x.look))) { out.push(q); continue; }
    }
    const rule = ANSWERED_BY.find((r) => r.words.some((w) => toks.has(w)));
    if (rule && rule.ok(b)) out.push(q);
  }
  return out;
}

/**
 * Entries a `note_brief` patch will DROP, as sentences for the model.
 *
 * `mergeNamed` requires an object with a `name` and silently skips anything
 * else, and `note_brief` then answered `{noted: true}` over a list that lost
 * every entry — measured: a patch of `world: ["Docking Ring", "Command Deck"]`
 * merges to `[]` and reports success. Models send a bare string array for a
 * list-shaped field often enough that the schema alone does not settle it, and
 * a drop with no trace is the worst version of this: the interview believes it
 * wrote the place down and never asks again.
 */
export function briefPatchProblems(patch) {
  const p = patch && typeof patch === "object" ? patch : {};
  const out = [];
  for (const key of Object.keys(PEOPLE)) {
    if (p[key] === undefined) continue;
    if (!Array.isArray(p[key])) {
      out.push(`"${key}" must be an ARRAY of {"name": …} objects — that part of the patch was dropped.`);
      continue;
    }
    const bad = p[key].filter((x) => !clean(x?.name));
    if (!bad.length) continue;
    const shown = bad.slice(0, 3)
      .map((x) => (typeof x === "string" ? `"${x}"` : JSON.stringify(x).slice(0, 48)))
      .join(", ");
    out.push(`${bad.length} "${key}" ${bad.length === 1 ? "entry" : "entries"} had no "name" and `
             + `${bad.length === 1 ? "was" : "were"} dropped (${shown}). Each one is an object: `
             + `{"name": "…", "look": "…"} — resend them.`);
  }
  return out;
}

/** Merge one named record (cast member / location / prop) into a list, by name.
 *  `previous_name` renames in place — without it, "actually, call her Mara"
 *  leaves the placeholder behind and the planner gets two characters. */
function mergeNamed(base, patch, fields) {
  const out = (Array.isArray(base) ? base : []).map((x) => ({ ...x }));
  const find = (n) => out.find((x) => clean(x.name).toLowerCase() === clean(n).toLowerCase());
  /** The same thing under a plural, a possessive or an article — "Cloudy Glass
   *  Marbles" arriving over "Cloudy Glass Marble". Nothing needs to be inferred
   *  there and no model needs to be asked, so it merges rather than becoming a
   *  second prop with its own reference sheet. Anything looser than this is a
   *  guess and goes to `duplicateGroups` for the model to confirm instead. */
  const findByKey = (n) => {
    const k = nameKey(n);
    return k ? out.find((x) => nameKey(x.name) === k) : undefined;
  };
  for (const raw of Array.isArray(patch) ? patch : []) {
    const name = clean(raw?.name);
    if (!name) continue;
    const prev = clean(raw?.previous_name);
    const byName = find(name);
    // A rename replaces the stored name; a plain reference keeps it, so
    // "mara" in a later patch can't recase the character to lower case.
    const hit = byName ?? (prev ? find(prev) ?? findByKey(prev) : undefined) ?? findByKey(name);
    const target = hit ?? { name };
    if (hit && !byName) target.name = name;
    for (const f of fields) if (clean(raw?.[f])) target[f] = clean(raw[f]);
    for (const f of NAMED_LIST_FIELDS) {
      const incoming = assetIds(raw?.[f]);
      if (incoming.length) {
        target[f] = [...new Set([...(target[f] ?? []), ...incoming])];
      }
    }
    if (!hit) out.push(target);
  }
  return out;
}

/**
 * Fold a `note_brief` patch into the accumulated brief.
 *
 * Everything is additive on purpose: the model streams what it just learned,
 * not the whole document, so a short patch must never erase earlier facts.
 * Strings overwrite when non-empty (the model refines a logline over the
 * conversation), lists union, cast/world/props merge per named entry.
 * Mirrored by `_merge_brief` in worker/director_tools.py — keep them in step.
 */
export function mergeBrief(base, patch) {
  const out = { ...(base && typeof base === "object" ? base : {}) };
  const p = patch && typeof patch === "object" ? patch : {};

  for (const f of STR_FIELDS) if (clean(p[f])) out[f] = clean(p[f]);
  for (const f of LIST_FIELDS) {
    const incoming = Array.isArray(p[f]) ? p[f] : clean(p[f]) ? [p[f]] : [];
    if (!incoming.length) continue;
    const merged = uniq([...(out[f] ?? []), ...incoming]);
    // Tidy the whole list, not just the patch, so anything already stored from
    // an earlier turn clears itself out too.
    out[f] = f === "open_questions" ? tidyQuestions(merged) : merged;
  }
  for (const [key, fields] of Object.entries(PEOPLE)) {
    if (p[key] !== undefined) out[key] = mergeNamed(out[key], p[key], fields);
  }
  if (p.shape && typeof p.shape === "object") {
    const shape = { ...(out.shape ?? {}) };
    if (Number(p.shape.length_s) > 0) shape.length_s = Math.round(Number(p.shape.length_s));
    if (clean(p.shape.structure)) shape.structure = clean(p.shape.structure);
    if (Array.isArray(p.shape.sections) && p.shape.sections.length) {
      shape.sections = uniq(p.shape.sections);
    }
    out.shape = shape;
  }
  if (p.song && typeof p.song === "object") {
    // Per-key replace, like `shape`: a rewritten chorus is a REWRITE, so the
    // lyric field overwrites rather than accumulating two drafts of the same
    // song. Keys the patch omits survive, so "make it 90 BPM" does not wipe
    // the words.
    const song = { ...(out.song ?? {}) };
    if (clean(p.song.lyrics)) song.lyrics = clean(p.song.lyrics);
    if (clean(p.song.style)) song.style = clean(p.song.style);
    if (typeof p.song.instrumental === "boolean") song.instrumental = p.song.instrumental;
    if (Number(p.song.length_s) > 0) song.length_s = Math.round(Number(p.song.length_s));
    if (Number(p.song.bpm) > 0) song.bpm = Math.round(Number(p.song.bpm));
    if (Object.keys(song).length) out.song = song;
  }
  if (p.expert_notes && typeof p.expert_notes === "object") {
    const notes = { ...(out.expert_notes ?? {}) };
    for (const [id, note] of Object.entries(p.expert_notes)) {
      if (EXPERT_IDS.includes(id) && clean(note)) notes[id] = clean(note);
    }
    out.expert_notes = notes;
  }
  // `ready` is the model's own call that the brief will survive planning; it
  // may withdraw it if the user reopens something, so honour false too.
  if (typeof p.ready === "boolean") out.ready = p.ready;
  // Answered questions stop being open ones. Matched on OVERLAP and not on the
  // "exact text" the schema asks for, because models paraphrase what they were
  // shown — see `sameQuestion`.
  if (Array.isArray(p.resolved_questions) && Array.isArray(out.open_questions)) {
    const done = p.resolved_questions.map((q) => clean(q)).filter(Boolean);
    out.open_questions = out.open_questions.filter((q) => !done.some(
      (d) => d.toLowerCase() === clean(q).toLowerCase() || sameQuestion(d, q)));
  }
  // The one subtractive move: the user vetoed something the model wrote down.
  if (p.remove && typeof p.remove === "object") {
    for (const key of [...Object.keys(PEOPLE), ...LIST_FIELDS]) {
      const drop = Array.isArray(p.remove[key]) ? p.remove[key] : [];
      if (!drop.length || !Array.isArray(out[key])) continue;
      const gone = new Set(drop.map((n) => clean(n).toLowerCase()));
      out[key] = out[key].filter((x) =>
        !gone.has(clean(typeof x === "string" ? x : x?.name).toLowerCase()));
    }
  }
  // Tidy and retire the WHOLE list, UNCONDITIONALLY. Both used to run only
  // inside the LIST_FIELDS loop, which `continue`s when the patch carries no
  // open_questions — so a stored list was never revisited by any patch that
  // did not happen to mention it. Measured: seventy stale questions survived
  // every turn of a real interview that way.
  if (Array.isArray(out.open_questions) && out.open_questions.length) {
    const tidy = tidyQuestions(out.open_questions);
    const answered = new Set(answeredQuestions({ ...out, open_questions: tidy }));
    out.open_questions = tidy.filter((q) => !answered.has(q));
  }
  return out;
}

/** What's still missing before planning can produce something coherent. */
export function briefReadiness(brief) {
  const b = brief ?? {};
  const checks = [
    { key: "story", label: "a premise", ok: !!(clean(b.logline) || clean(b.premise)) },
    { key: "turn", label: "the turn", ok: !!clean(b.turn) },
    // A supplied sheet IS the look, and a stricter reading of this made the
    // one case where the user has already done the design work read as the
    // least ready brief on screen.
    { key: "cast", label: "a named cast member with a look",
      ok: (b.cast ?? []).some((c) => clean(c.name) && (clean(c.look) || c.ref_asset_ids?.length)) },
    { key: "world", label: "somewhere it happens", ok: (b.world ?? []).some((w) => clean(w.name)) },
    { key: "look", label: "tone or palette", ok: !!(clean(b.tone) || clean(b.palette)) },
  ];
  const missing = checks.filter((c) => !c.ok);
  return {
    checks,
    missing: missing.map((c) => c.label),
    filled: checks.length - missing.length,
    total: checks.length,
    /** the model's flag wins once the floor is met — it knows what it asked */
    ready: missing.length === 0 && b.ready !== false,
    enough: missing.length === 0,
  };
}

/** Words that carry no identity, so "the Portal Machine" and "a portal machine"
 *  are one thing and "Guide Rei's Cloudy Marble" and "Cloudy Marble" agree on
 *  what is being named. */
const NOISE_WORDS = new Set(["the", "a", "an", "of", "s"]);

/** A name reduced to what it is actually naming: lower case, no possessives,
 *  no articles, singular. "Cloudy Glass Marbles" and "Guide Rei's cloudy glass
 *  marble" both become "cloudy glass marble" plus a name token. */
export function nameKey(s) {
  return (s ?? "").toLowerCase()
    .replace(/[’']s\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !NOISE_WORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .join(" ");
}

/** The opening of a description as a bag of words — how the duplicates that
 *  share NO name tokens get caught. Deliberately a SET compared by overlap and
 *  not a string compared for equality: the real pair differed only by an
 *  inserted "that" and a different closing clause ("edged by a thin ring" /
 *  "edged by a ring of light"), which a prefix comparison scores as unrelated. */
const LOOK_WORDS = 12;
const LOOK_MIN = 6;             // too short to be evidence of anything
const lookWords = (x) => {
  const words = nameKey(String(x?.look ?? "").split(/[.;]/)[0]).split(" ").filter(Boolean);
  return new Set(words.slice(0, LOOK_WORDS));
};
const jaccard = (a, b) => {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return union ? shared / union : 0;
};

/**
 * How alike two entries have to be before they are reported as one thing —
 * and it is NOT the same question for people as for places.
 *
 * Measured across a real 20-entry brief. On raw text, `Rei` and `Villian Rei`
 * — two deliberate entries — scored 0.60 on their looks, exactly what the
 * genuine location duplicate `Astronaut Capture Site` / `Astronaut Capture
 * Environment` scored, so no single threshold separated them. `commonWords`
 * turned out to be the better half of the answer (their similarity was a stock
 * opener, and stripping it drops the real cast to no matches under EITHER
 * rule), and this table is now the backstop for what that filter cannot see:
 * it needs three entries to call anything common, so a cast of two is
 * unprotected by it — and this app's cast is full of deliberate near-twins,
 * outfit variants being their own character entries by design. A false
 * positive here invites the model to merge two people, which is the most
 * expensive mistake in this file; a missed one costs a duplicate sheet.
 */
const DUPE_RULES = {
  cast:    { name: 1.01, look: 1.01, lookAlone: 0.9 },   // effectively: verbatim only
  default: { name: 0.5,  look: 0.3,  lookAlone: 0.7 },
};

/**
 * Words this list uses for EVERYTHING, which therefore say nothing about
 * whether two of its entries are the same thing.
 *
 * Models write a stock opener — "Reference authority: short black bob with one
 * turquoise front streak, pale gray eyes, black…" in front of every character —
 * and a bag-of-words comparison then scores an entire cast at 1.0. Dropping
 * what half the list shares is the standard answer, and it leaves exactly the
 * distinctive part: the hoodie, the armour, the layered coat.
 */
function commonWords(items) {
  const seen = new Map();
  for (const it of items) for (const w of lookWords(it)) seen.set(w, (seen.get(w) ?? 0) + 1);
  // Half the list, but never fewer than THREE entries. The floor is what keeps
  // the filter from eating the signal: two duplicates among three share their
  // words in 2 of 3, and dropping those would hide exactly what is being looked
  // for. At three it takes the whole list to count as boilerplate.
  const floor = Math.max(3, Math.ceil(items.length / 2));
  return new Set([...seen].filter(([, n]) => n >= floor).map(([w]) => w));
}

function looksLikeOne(a, b, rule, common) {
  const strip = (s) => new Set([...s].filter((w) => !common.has(w)));
  const al = strip(lookWords(a)), bl = strip(lookWords(b));
  if (al.size < LOOK_MIN || bl.size < LOOK_MIN) return false;
  const lj = jaccard(al, bl);
  if (lj >= rule.lookAlone) return true;
  const nj = jaccard(new Set(nameKey(a.name).split(" ").filter(Boolean)),
                     new Set(nameKey(b.name).split(" ").filter(Boolean)));
  return nj >= rule.name && lj >= rule.look;
}

/**
 * Entries in one list that look like the same thing, as groups of names.
 *
 * Deterministic, and phrased for the model as an instruction, for the reason
 * this codebase keeps rediscovering: a model agrees with "don't write the same
 * prop down twice" and then writes it down four times. A check is what changes
 * that.
 *
 * Two entries group on an EQUAL reduced name, or on `DUPE_RULES` for their
 * kind. Deliberately NOT on one name containing the other: "Rei" and "Guide
 * Rei" are two characters in a real project here, and a hint telling the model
 * they are one invites it to merge two people.
 *
 * @param {any[]} list
 * @param {"cast"|"world"|"props"} [kind] which rule applies — see DUPE_RULES
 */
export function duplicateGroups(list, kind) {
  const rule = DUPE_RULES[kind] ?? DUPE_RULES.default;
  const items = (Array.isArray(list) ? list : []).filter((x) => clean(x?.name));
  const common = commonWords(items);
  const groups = [];
  const placed = new Set();
  for (let i = 0; i < items.length; i++) {
    if (placed.has(i)) continue;
    const a = items[i], ak = nameKey(a.name);
    const group = [a.name];
    for (let j = i + 1; j < items.length; j++) {
      if (placed.has(j)) continue;
      const b = items[j];
      if ((ak && ak === nameKey(b.name)) || looksLikeOne(a, b, rule, common)) {
        placed.add(j);
        group.push(b.name);
      }
    }
    if (group.length > 1) { placed.add(i); groups.push(group); }
  }
  return groups;
}

/**
 * What note_brief hands back to the model. Not a receipt — a mirror: the names
 * it is now holding and the questions still marked open, because a model that
 * cannot see the merged state renames by adding a second character and leaves
 * answered questions open forever. Both writers (api + worker) return this.
 *
 * PROPS were missing from this mirror for its whole life, and props are what
 * duplicated: one object came back as "Cloudy Glass Marbles", "Contained Black
 * Hole Marble" and "Guide Rei's Cloudy Marble" in a single brief. The model was
 * being asked not to repeat itself about a list it was never shown.
 */
export function noteBriefResult(brief, patch) {
  const r = briefReadiness(brief);
  const names = (list) => (list ?? []).map((x) => x.name).filter(Boolean);
  const open = brief.open_questions ?? [];
  const hints = [];
  const dropped = briefPatchProblems(patch);
  if (dropped.length) hints.push(dropped.join(" "));
  const dupes = [];
  for (const [key, label] of [["cast", "cast"], ["world", "location"], ["props", "prop"]]) {
    for (const group of duplicateGroups(brief[key], key)) {
      dupes.push(`${label}: ${group.map((n) => `"${n}"`).join(" / ")}`);
    }
  }
  if (dupes.length) {
    hints.push("These look like the SAME thing written down more than once: " +
               `${dupes.join("; ")}. If any group is one thing, resend the keeper with ` +
               "previous_name set to each of the others, one call per merge — the planner " +
               "makes a separate sheet for every name here.");
  }
  // ONE LOCATION FOR A MULTI-SECTION PIECE, which is the shape of the failure
  // this check exists for. Asked for a station with a docking ring, a command
  // deck, a maintenance spine, an observation gallery and a salvage bay, the
  // model wrote all five into ONE entry's `look` and reported them as added —
  // truthfully, and uselessly: the brief carried one location, so the planner
  // would draw one master plate and five sets collapse to one camera position.
  // It was doing what it was told; the roster rule above prices duplicates and
  // nothing priced the opposite.
  //
  // A PROSE check was written first and thrown away. The nested look and a
  // correct one are both comma enumerations — "welded hull plates, cargo nets,
  // gantries, hanging work lamps" is dressing INSIDE one bay — and nothing
  // separates them without a vocabulary of place nouns that would go stale.
  // This one counts entries against the shape the model itself wrote down, so
  // it is exact, and it goes quiet the moment the split happens.
  //
  // A bottle episode really is one location, so the escape is saying so in
  // constraints rather than a threshold nobody can satisfy.
  const sections = (brief.shape?.sections ?? []).length;
  const bottle = (brief.constraints ?? []).some(
    (c) => /\b(one|single|bottle)\b/i.test(c) && /\b(location|room|set|setting)\b/i.test(c));
  if ((brief.world ?? []).length === 1 && !bottle
      && (sections >= 3 || Number(brief.shape?.length_s) >= 120)) {
    hints.push(`The brief holds ONE location for a ${
      sections >= 3 ? `${sections}-section` : `${brief.shape?.length_s}s`} piece. A place the `
      + "camera cuts to is its own world entry — if that one's look names several (a deck, a "
      + "bay, a corridor), send each as its own {\"name\", \"look\"}. If it really is one "
      + "set, say so in constraints.");
  }
  if (open.length) {
    hints.push("Answered questions retire themselves; send resolved_questions only for one "
               + "the brief cannot show is settled.");
  }
  return {
    noted: true,
    ready: r.ready,
    still_missing: r.missing,
    cast: names(brief.cast), world: names(brief.world), props: names(brief.props),
    open_questions: open,
    ...(dropped.length ? { dropped } : {}),
    ...(hints.length ? { hint: hints.join(" ") } : {}),
  };
}

/**
 * The brief as the model should see its own state: a ROSTER first, prose second.
 *
 * This used to be `JSON.stringify(brief).slice(0, 4000)`, and the truncation is
 * what produced the duplicate props. Measured on a real thread: the brief was
 * 14,670 characters and the `"props"` key began at 3,960 — so the model's view
 * of its own state was cut off forty characters into the list, and it went on
 * writing down the same marble under a new name every turn because it could not
 * see the three already there.
 *
 * So every NAME is always present and never truncated; only the prose is
 * clipped, per field, and the cap is on the descriptions rather than on the
 * document. A roster the model can read is the difference between "don't
 * repeat yourself" being an instruction and being a wish.
 */
export function briefDigest(brief, { maxChars = 8000 } = {}) {
  const b = brief ?? {};
  const lines = [];
  const clip = (s, n) => {
    const t = clean(s).replace(/\s+/g, " ");
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  for (const f of STR_FIELDS) if (clean(b[f])) lines.push(`${f}: ${clip(b[f], 220)}`);
  for (const [key, fields] of Object.entries(PEOPLE)) {
    const items = b[key] ?? [];
    if (!items.length) continue;
    lines.push(`${key} (${items.length}) — every one you are holding:`);
    for (const it of items) {
      const detail = fields.map((f) => clean(it[f])).filter(Boolean).join(" — ");
      lines.push(`  · ${clean(it.name)}${detail ? `: ${clip(detail, 130)}` : ""}` +
                 `${it.ref_asset_ids?.length ? "  [user sheet attached]" : ""}`);
    }
  }
  for (const f of LIST_FIELDS) {
    if (b[f]?.length) lines.push(`${f}: ${clip((b[f] ?? []).join("; "), 300)}`);
  }
  if (b.shape) {
    const shape = [b.shape.length_s && `${b.shape.length_s}s`, clean(b.shape.structure),
                   (b.shape.sections ?? []).join(" / ")].filter(Boolean).join(" — ");
    if (shape) lines.push(`shape: ${clip(shape, 220)}`);
  }
  for (const [id, note] of Object.entries(b.expert_notes ?? {})) {
    if (clean(note)) lines.push(`${expertById(id)?.label ?? id} note: ${clip(note, 160)}`);
  }
  // A last-resort ceiling. It cuts the TAIL (notes and lists), never the
  // roster, because the roster is the part being reasoned against.
  const out = lines.join("\n");
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n…(clipped)` : out;
}

/** Rough "is there anything in here at all" test, for empty-state UI. */
export const briefIsEmpty = (b) =>
  !b || !Object.keys(b).some((k) =>
    k !== "ready" && (Array.isArray(b[k]) ? b[k].length : b[k] && Object.keys(b[k]).length !== 0));

/**
 * Compile the brief into what plan_storyboard actually reads: a logline and a
 * notes block. The planner has its own prompt; this is the handoff, and it has
 * to be lossless enough that nothing the user said in the interview evaporates.
 *
 * @param {Record<string, any>} brief
 * @param {{ lengthS?: number, experts?: string[], medium?: string|null }} [opts]
 * @returns {{ logline: string, notes: string }}
 */
export function briefToPlan(brief, { lengthS, experts = [], medium } = {}) {
  const b = brief ?? {};
  const logline = clean(b.logline) || clean(b.premise) || clean(b.title);
  const lines = [];
  const push = (head, body) => body && lines.push(`${head}: ${body}`);

  if (clean(b.premise) && clean(b.premise) !== logline) push("Premise", clean(b.premise));
  push("The turn", clean(b.turn));
  push("Ending", clean(b.ending));
  push("Tone", clean(b.tone));
  push("Palette & light", clean(b.palette));
  push("Audience", clean(b.audience));

  // A supplied picture is the design, so the writer is told the look is FIXED
  // rather than left to invent one that the staged sheet will then contradict.
  const supplied = (x) => (x.ref_asset_ids?.length
    ? ` [the user supplied ${x.ref_asset_ids.length === 1 ? "a reference sheet"
        : `${x.ref_asset_ids.length} reference sheets`} for this one — the look is `
      + `fixed; describe it, don't redesign it]`
    : "");
  for (const c of b.cast ?? []) {
    const bits = [clean(c.role), clean(c.look), clean(c.want) && `wants ${clean(c.want)}`]
      .filter(Boolean).join(" — ");
    lines.push(`Cast · ${clean(c.name)}${bits ? `: ${bits}` : ""}${supplied(c)}`);
  }
  for (const w of b.world ?? []) {
    const bits = [clean(w.when), clean(w.look)].filter(Boolean).join(" — ");
    lines.push(`Location · ${clean(w.name)}${bits ? `: ${bits}` : ""}${supplied(w)}`);
  }
  for (const p of b.props ?? []) {
    const bits = [clean(p.look), clean(p.why)].filter(Boolean).join(" — ");
    lines.push(`Prop · ${clean(p.name)}${bits ? `: ${bits}` : ""}${supplied(p)}`);
  }
  push("Motifs", (b.motifs ?? []).join("; "));
  push("References", (b.references ?? []).join("; "));
  push("Constraints", (b.constraints ?? []).join("; "));
  // The song reaches the planner two ways and they are different things: this
  // is what the WRITER reads (so the video is built around the words), while
  // `brief.music` — which the wizard fills from the same object — is what
  // actually queues the render.
  if (b.song?.style) push("Track", clean(b.song.style));
  if (b.song?.lyrics) push("Lyrics", `\n${clean(b.song.lyrics)}`);
  if (b.shape?.structure) push("Structure", clean(b.shape.structure));
  if (b.shape?.sections?.length) push("Sections", b.shape.sections.join(" / "));

  for (const [id, note] of Object.entries(b.expert_notes ?? {})) {
    const e = expertById(id);
    if (e && clean(note)) lines.push(`${e.label} note: ${clean(note)}`);
  }
  if (experts.length) {
    lines.push(`Experts in the room: ${experts.map((id) => expertById(id)?.label ?? id).join(", ")}.`);
  }
  if (b.open_questions?.length) {
    lines.push(`Left open (decide these yourself, consistently): ${b.open_questions.join("; ")}`);
  }
  const length = Number(b.shape?.length_s) || Number(lengthS) || 0;
  if (length) lines.push(`Target length: ${length}s${medium ? ` (${medium.replace("_", " ")})` : ""}.`);

  return { logline: logline || "", notes: lines.join("\n") };
}

// ------------------------------------------------------------- tool schema ---
const S = (description) => ({ type: "string", description });
const REF_ASSET_IDS = {
  type: "array",
  items: { type: "string" },
  description:
    "asset ids of pictures the USER attached for this one — copy the id out of " +
    "the [image asset <id>] line above their message. These become its actual " +
    "reference sheets, so nothing is drawn from your description of them. Only " +
    "ever an id the user attached; never invent one.",
};

const NAMED = (description, fields) => ({
  type: "array",
  description,
  items: {
    type: "object",
    properties: {
      name: S("the name you will call them by, consistently"),
      previous_name: S("what this was called before, when the user renames it — renames in place"),
      ...fields,
      ref_asset_ids: REF_ASSET_IDS,
    },
    required: ["name"],
  },
});

/** What `note_brief` tells the model it is for.
 *
 *  HERE RATHER THAN IN THE ROUTE because there are three runners now — the
 *  hosted endpoint, the worker, and the BROWSER when the turn is answered on
 *  this machine (`src/lib/localBrief.ts`). A description is the only thing
 *  that decides whether a tool is reached for at all, so two copies of it is
 *  two interviews that write different amounts down. */
export const NOTE_BRIEF_DESC =
  "Write down what you have established. Send only what is new or changed — it " +
  "merges into the brief on screen. Call this every turn where anything was settled.";

/** What `get_project_state` tells the model it is for. Same three runners. */
export const STATE_DESC =
  "Read the project: medium/style, existing bible entries (reuse these characters " +
  "and locations by name instead of inventing near-duplicates), episodes, and which " +
  "lore documents have been imported. Read the lore ones with search_lore before " +
  "proposing anything they may already have settled.";

/** JSON-Schema for note_brief. Anthropic takes it as `input_schema`; the
 *  OpenAI-compatible path wraps it as a function's `parameters`. */
export const NOTE_BRIEF_SCHEMA = {
  type: "object",
  properties: {
    title: S("working title, once one is obvious"),
    logline: S("one sentence: who wants what, against what, where"),
    premise: S("2-3 sentences of what happens"),
    turn: S("the emotional turn — where it flips and who loses what"),
    ending: S("how it lands, if the user has said"),
    tone: S("tone and feel in concrete words, not genre labels alone"),
    palette: S("colour palette and light sources, named colours"),
    audience: S("who it is for / where it plays, if said"),
    cast: NAMED("characters established so far — add or refine one at a time", {
      role: S("their function in the story"),
      look: S("concrete visual attributes: hair, eyes, build, marks, wardrobe"),
      want: S("what they want in this piece"),
    }),
    world: NAMED("locations established so far", {
      look: S("what it looks like: materials, light, weather, scale"),
      when: S("time of day / era"),
    }),
    props: NAMED("objects the story turns on", {
      look: S("what it looks like"), why: S("why it matters"),
    }),
    motifs: { type: "array", items: { type: "string" }, description: "recurring images or symbols" },
    references: { type: "array", items: { type: "string" }, description: "films, artists, looks the user named" },
    constraints: { type: "array", items: { type: "string" }, description: "hard requirements or things to avoid" },
    open_questions: {
      type: "array", items: { type: "string" },
      description: "gaps you still need filled, as short stubs of 2-6 words — " +
        "\"tone: action or dread\", \"who we follow\", \"what season\". Never the " +
        "sentence you just asked; the user is already reading it.",
    },
    resolved_questions: { type: "array", items: { type: "string" },
                          description: "previously open questions now answered (exact text)" },
    song: {
      type: "object",
      // The interview is already TOLD to ask about the track on a music video
      // (see the medium line in the prompt below) and until this field existed
      // there was nowhere to put the answer: `mergeBrief` is a whitelist, so a
      // lyric sheet the director wrote down was silently dropped and the tick
      // beside the tool call said it had been saved. Anything the studio will
      // MAKE has to be storable here, or the interview is theatre.
      description: "the track, when the piece has an original one. The studio "
        + "renders it with the episode — write it down here rather than saying "
        + "you cannot make audio.",
      properties: {
        lyrics: S("the words, with [Verse]/[Chorus]/[Bridge]/[Outro] section tags"),
        style: S("what the record sounds like: genre, tempo, instruments, the "
                 + "vocal, the production"),
        instrumental: { type: "boolean", description: "no vocals" },
        length_s: { type: "integer", description: "target length in seconds" },
        bpm: { type: "integer", description: "tempo, if it has been decided" },
      },
    },
    shape: {
      type: "object",
      description: "the shape of the piece",
      properties: {
        length_s: { type: "integer", description: "target length in seconds" },
        structure: S("how it is built: e.g. cold open / escalation / turn / tag"),
        sections: { type: "array", items: { type: "string" }, description: "named sections in order" },
      },
    },
    expert_notes: {
      type: "object",
      description: "one decision per expert in the room, in their own terms",
      properties: Object.fromEntries(EXPERTS.map((e) => [e.id, S(e.brief)])),
    },
    remove: {
      type: "object",
      description: "drop entries the user vetoed, by name/text",
      properties: Object.fromEntries(
        [...Object.keys(PEOPLE), ...LIST_FIELDS].map(
          (k) => [k, { type: "array", items: { type: "string" } }])),
    },
    ready: { type: "boolean",
             description: "true once premise, turn, a described cast member, a location and a look are all settled" },
  },
};

// ----------------------------------------------------------- the interview ---
/**
 * The instructions that turn the director persona into an interviewer. Appended
 * to buildPersona() output so all the craft knowledge still applies.
 *
 * @param {{ project?: Record<string, any>, experts?: string[], lengthS?: number,
 *           brief?: Record<string, any> }} [opts]
 * @returns {string}
 */
export function interviewSystem({ project = {}, experts = [], lengthS, brief } = {}) {
  const room = experts.map((id) => expertById(id)).filter(Boolean);
  const r = briefReadiness(brief);
  const state = briefIsEmpty(brief) ? "Nothing captured yet." : briefDigest(brief);

  return `# Right now you are running the brief interview

The user just opened the one-shot wizard for "${project.title ?? "an untitled project"}"${
    project.medium ? ` — a ${String(project.medium).replace("_", " ")}` : ""}${
    project.style ? `, ${project.style}` : ""}${
    project.genre?.length ? ` (${project.genre.join(", ")})` : ""}. Target length ${
    Number(lengthS) || 60}s. ${project.logline ? `Project logline on file: "${project.logline}".` : ""}

Your job in this conversation is to walk out with a brief that can be planned:
a premise, the turn, a named cast with concrete looks, locations, a look and
feel, and the shape. You are a director in a room with the user, not a form.

How to run it:
- Ask ONE question per turn (two only if they are the same question). Short.
- Never ask something you can propose instead. Offer a concrete option and let
  the user veto it: "I'd make her a shipbreaker, mid-40s, salt-burned hands —
  or is she younger than that?" Proposals move faster than blank prompts.
- When the user gives you a lot at once, take all of it and ask only about what
  is genuinely load-bearing and missing.
- Write down what you learn as you go, in your own concrete language. Looks must
  be visual and countable (hair, eyes, build, marks, named garments), because
  those lines get repeated verbatim into every shot.
- Only write down a proposal you actually made out loud in your reply. Do not
  invent attributes the user never heard you say — they cannot veto what they
  were not told.
- Never restate the whole brief in prose. It is on screen beside you, so no
  recaps and no bullet lists of what we have. Your whole reply is at most two
  sentences: one line of acknowledgement, then the question.
- note_brief hands back every cast member, location and prop you are holding,
  and the questions still open. Read it: it is how you notice you just created
  a second character instead of renaming one, or that a question got answered.
- **Before adding a cast member, a location or a prop, check the roster below
  for it.** The same object described from a new angle is not a new object —
  one marble seen at rest, thrown, and unfolded is ONE prop, not three. Every
  name on that list gets its own reference sheet rendered, so a duplicate is a
  wasted sheet and a continuity break, not a tidiness problem. Refine the entry
  that is already there; if you have already split one thing in two, send the
  keeper with previous_name set to the other.
- **The opposite mistake costs exactly as much: a place the camera CUTS TO is
  its own world entry, and an object a shot holds on is its own prop.** Never
  nest them in one entry's look — "a station of exterior docking rings, a
  command deck, a maintenance spine and a salvage bay" is FOUR locations
  written as one, and the planner draws a single plate for it, so four sets
  become one camera position. The rule above is about one thing described
  twice; this is about several things described once. Send each as its own
  {name, look}.
${room.length ? `- Experts in the room: ${room.map((e) => `${e.label} (${e.brief})`).join("; ")}. Pull each of \
them in at least once and record what they decided in expert_notes. Speak as \
them briefly when it is their call — "Costume says: …".` : ""}
- ${project.medium === "music_video"
      ? "This is a music video: ask early about the track, its sections and the performance-vs-narrative balance."
      : "Keep the story turning on people wanting things, not on plot summary."}
- **The studio generates music.** If the piece has an original track, write the
  words and the sound into "song" and say it will be rendered with the episode —
  never that you cannot make audio. You do not render it here (there is no
  episode yet to hang it on); the plan does, in the background, and it lands on
  the storyboard page. Asked to "generate it", the right move is to write the
  song down and say what happens next.

Tool use is not optional:
- Call note_brief EVERY turn where anything was established — before or after
  your reply, but never skip it. Send only what is new or changed; it merges.
  A turn that settled nothing needs no call at all: never pad it by writing
  down the question you just asked. open_questions holds short stubs of what
  is missing ("tone: action or dread"), not the sentences you said. A gap
  retires itself once the brief answers it, so do not re-raise one about
  something that already has a look — sharpen the look instead.
- When the user renames someone or somewhere you already wrote down, send the
  new name with previous_name set, so it renames instead of duplicating. When
  they veto something, use remove.
- A PICTURE the user attaches is the strongest thing they can hand you. Put its
  id (from the [image asset <id>] line above their message) in that character's
  or location's ref_asset_ids and it becomes the real reference sheet — the
  planner stages it instead of drawing one. So: say what you see in it, ask
  who or what it is if that is not obvious, and do not re-describe the design
  in your own words as though you were proposing it. Attach it to exactly the
  one it shows; if two people are in it, ask which.
- Call get_project_state once at the start if the project might already have
  bible entries worth reusing. Reuse existing characters by name rather than
  inventing near-duplicates.
- When premise, turn, one described cast member, a location and a look are all
  settled, set ready:true, say in one or two lines what you have, and tell the
  user to hit "Draft cast & world" whenever they like — they can also keep
  going and refine. Do not stall waiting for perfection; note what is still
  open in open_questions and let the planner decide it consistently.
- The user can hit "Draft cast & world" at any time. Nothing you say blocks it.

Never write H3 prompt format here, and never claim you generated anything —
this step only produces the brief.

# Brief captured so far — this is the complete roster, not a sample
${state}
Still missing: ${r.missing.length ? r.missing.join(", ") : "nothing — you may set ready:true"}.`;
}

/** The first thing the director says, before the user types anything. */
export function openingLine(project = {}) {
  const kind = String(project.medium ?? "film").replace("_", " ");
  return `Tell me what we're making. I'll ask until I have a cast, a world and a shape — ` +
    `then you hit "Draft cast & world" and I'll build the ${kind}.`;
}

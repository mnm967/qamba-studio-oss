// How a panel and a key still are COMPOSED — the pure half of lib/panels.ts.
//
// Split out for one reason: `panels.ts` imports `enqueueJob`, which reaches
// supabase, so nothing in it could be tested without a database. The
// composition is the part that fails silently — a reference picked by the
// wrong role, an anchor ordered into the weak slot, a camera line truncated —
// and it is all pure functions over rows. `panels.ts` re-exports everything
// here, so callers keep importing one module.
import type { Beat, BibleEntry, Scene } from "./db/types";

/** Same geometry tier 1 uses, so a redrawn panel is swappable with a planned
 *  one. Krea 2 snaps its own dims; 704 is what the planner asks for. */
export const PANEL_W = 1280;
export const PANEL_H = 704;

export interface PanelCtx {
  projectId?: string | null;
  episodeId?: string | null;
  /** the project's style line — the grade every panel of a scene repeats.
   *  Comes from panelDefaults; don't hand-roll it. */
  style: string;
  /** catalog id. A panel renders on the model the bible was drawn with: a
   *  panel that doesn't look like the show is not a usable reference. */
  imageModel: string;
  bible: BibleEntry[];
  /** default USER_PRIORITY — anything a human clicked outruns the queue */
  priority?: number;
  /** Hosted render quality, from `panelDefaults`. Only the hosted rows that
   *  expose one read it; the worker already defaults panels to low, so this
   *  is the project overriding that rather than the only thing that sets it. */
  quality?: string | null;
}

const firstName = (n: string) => n.split(" — ")[0];

/** One staged reference, as the H3 envelope needs to talk about it: which
 *  `<Subject N>` it defines and what that subject is. Ordered identically to
 *  `refs`/`anchors`, so `<Picture N>` is just the 1-based index. */
export interface RefSubject {
  kind: "character" | "location";
  name: string;
  identity: string | null;
}

/** The ONE picture that conditions this character in a panel.
 *
 *  It used to be `roles: ["face"]`, always, and for an outfit variant it was
 *  the PARENT's face — the variant sheet being "wardrobe, not identity". Both
 *  halves of that are wrong for a panel, and they fail the same way: a face
 *  plate is head-and-shoulders on grey, so it says nothing about what the
 *  character is WEARING, and the model dresses them from the prose. Measured on
 *  an Astronaut Rei / Villian Rei two-shot — one figure came back in an invented
 *  orange spacesuit, because the only picture of her was a face.
 *
 *  So the order is wardrobe-first, and it matches what `ref_plan_for` already
 *  does on the block side:
 *
 *  - a base character prefers the TURNAROUND, which is a face plate too (two of
 *    its six views are face close-ups) AND carries the whole costume from six
 *    angles — one slot doing both jobs;
 *  - an outfit VARIANT stages its own `full_body`, because that is the only
 *    picture of the costume that makes it a variant. Its face still comes from
 *    the parent, but through the identity the turnaround already carries rather
 *    than by spending a second slot on it.
 *
 *  `first` matters: `_resolve_anchor` appends EVERY role it finds, so a bare
 *  three-role list would stage three pictures per character and eat the panel's
 *  slot budget. This asks for the first that resolves. */
export function characterAnchor(c: BibleEntry): { entry_id: string; roles: string[]; first: true } {
  const variantOf = (c.doc as { variant_of?: string } | null)?.variant_of;
  return variantOf
    ? { entry_id: c.id, roles: ["full_body", "outfit", "turnaround", "face"], first: true }
    : { entry_id: c.id, roles: ["turnaround", "full_body", "outfit", "face"], first: true };
}

/** Shot sizes where the SPACE is the subject and a face is a few dozen pixels
 *  tall. Mirrors image_prompt.LOCATION_LED_SIZES; the worker owns the size
 *  extraction, this is the same decision made from the same camera prose.
 *  (INSERT was tried here and measurably lost — see the note on
 *  LOCATION_LED_SIZES.) */
const LOCATION_LED = /\b(extreme wide|establishing|wide|full)\b/i;
/** …but "medium wide" is a figure shot with the space readable behind it, and
 *  "wide" appears inside it. Longest-key-first, same as SHOT_FRAMING. */
const NOT_LOCATION_LED = /\b(medium wide|medium close-up|extreme close-up|close-up)\b/i;

export function locationLeads(camera: string): boolean {
  const cam = (camera || "").toLowerCase();
  const size = cam.split(";")[0];          // size+angle clause, before the motion
  if (NOT_LOCATION_LED.test(size)) return false;
  return LOCATION_LED.test(size);
}

/** Which of a location's four plates conditions a given shot. Twin of
 *  image_prompt.location_plate / PLATE_RING — see the long note there for the
 *  measurement. In one line: every panel of a scene staged the MASTER, so every
 *  panel of a scene was shot from one mark, and the close-ups only escaped
 *  because a face held image1 there instead.
 *
 *  `detail` is deliberately out of the ring — it is a macro of one surface, and
 *  a medium shot conditioned on it gets a wall. */
export const PLATE_RING = ["master", "alt_angle", "atmosphere"] as const;
const PLATE_SURFACE = /\b(insert|extreme close-up)\b/i;
const PLATE_REVERSE = /over[-\s]the[-\s]shoulder|reverse|from behind|\bbehind\b/i;

export function locationPlate(camera: string, turn = 0): [string[], boolean] {
  const cam = camera || "";
  if (PLATE_SURFACE.test(cam)) return [["detail", "master"], false];
  if (PLATE_REVERSE.test(cam)) return [["alt_angle", "master"], false];
  const i = turn % PLATE_RING.length;
  return [[...PLATE_RING.slice(i), ...PLATE_RING.slice(0, i)], true];
}

/** The whole scene's plate choices in one pass. The turn counter is per SCENE
 *  and only the rotating shots advance it, so a caller holding one beat cannot
 *  work it out alone — which is why `panelSpec` takes the scene's beats.
 *
 *  `startTurn` is where the ring picks up, read from `scenes.meta.plate_turn`
 *  (stamped by the planner, never recomputed here — a redraw sees one scene
 *  and cannot count the ones before it). It exists for the BOTTLE EPISODE:
 *  restarting at 0 every scene means twelve scenes in one room open on twelve
 *  master plates, which is the one-camera lock the rotation exists to break.
 *  Twin of image_prompt.plate_plan. */
export function platePlan(cameras: string[], startTurn = 0): string[][] {
  let turn = Number(startTurn) || 0;
  return cameras.map((cam) => {
    const [roles, took] = locationPlate(cam, turn);
    if (took) turn += 1;
    return roles;
  });
}

/** Which of these cast names the shot's own text says -> in mention order.
 *
 *  Twin of image_prompt.featured_cast, and it is the STAGING decision:
 *  `beats.meta.cast` is the cinematographer's roster (its contract says "ONLY
 *  the characters visibly in frame" and the model writes the roster anyway —
 *  ASTRONAUT_CAPTURE put all five names on every beat, so a close-up staged
 *  five references and montaged). Word-boundary, longest name first with each
 *  match consumed (the span is blanked so offsets hold): the cast is "Rei"
 *  plus four "<Something> Rei" variants, and a substring scan credits plain
 *  Rei with every mention of the others. Empty when the text names nobody —
 *  the caller falls back to the roster, because a beat can cast by pronoun
 *  ("the two stand in silence"). */
// Twin of image_prompt._BODY_TERMS — see there for why the list exists. This
// was the SHORT version of that list for months after the fight-choreography
// work grew the Python one, which is a divergence with no symptom until a
// fight: "drives the staff into Kai's ribs" reads as a detachable object here
// and as the man himself there, so one twin stages his sheet and the other
// does not.
const BODY_TERMS = "face|faces|eye|eyes|gaze|look|expression|hand|hands|palm|palms|finger|"
  + "fingers|fingertip|fingertips|fist|fists|arm|arms|elbow|elbows|wrist|"
  + "wrists|forearm|forearms|knuckle|knuckles|shoulder|"
  + "shoulders|head|hair|brow|jaw|mouth|lips|teeth|throat|neck|chest|back|"
  + "spine|waist|hip|hips|knee|knees|leg|legs|foot|feet|heel|heels|skin|body|"
  + "rib|ribs|ribcage|torso|midsection|midriff|stomach|belly|abdomen|gut|"
  + "sternum|collarbone|flank|side|shin|shins|calf|calves|thigh|thighs|"
  + "ankle|ankles|toe|toes|chin|cheek|cheeks|temple|forehead|scalp|ear|ears|"
  + "nose|tongue|armpit|groin|"
  // …and a possessive over your OWN MOTION is you, for the same reason: a
  // body cannot be separated from its momentum.
  + "pull|push|weight|momentum|charge|lunge|swing|strike|blow|kick|punch|"
  + "guard|reach|footing|balance|follow-through|"
  + "breath|voice|grip|silhouette|shadow|figure|frame|profile|posture|stance";
const BODY_AFTER = new RegExp(`^\\s*(?:\\w+\\s+){0,2}(?:${BODY_TERMS})\\b`);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The guards that replaced a `>= 4 characters` floor on a head/tail fragment.
// Twin of image_prompt._FUNCTION_WORDS / _DETERMINERS / _fragment_ok — see the
// long note there. In one line: "Ren", "Rei", "Kai", "Ana", "Jun" are the
// names people have, and this twin kept the floor for months after the Python
// dropped it. MEASURED on SPINE_RUN (2026-09-07): the planner staged Lucy AND
// Kai on the same beat this staged Lucy alone, H3 drew Kai from the prose that
// still names him, and 11 of the board's 59 panels diverged the same way.
//
// Length was standing in for two different worries and neither is length:
//   1. A FUNCTION WORD is never a person. "The Other Reader" has the head
//      "the", so these are refused categorically at any width.
//   2. A CONTENT WORD is told from a name by its DETERMINER. English puts an
//      article in front of a common noun and nothing in front of a name:
//      "she saw the tam on the hook" is a hat, "Tam crosses the shop" is a
//      person. That replaces a hand-written vocabulary of short nouns, which
//      would be invented knowledge going stale.
// Two letters stays refused outright. A refused fragment merely restores the
// old behaviour (fall back to the roster), so a false refusal is cheap and a
// false omission stages nobody.
const MIN_NAME_FRAGMENT = 3;
const SHORT_FRAGMENT_MAX = 4;      // below this width, the determiner test applies
const FUNCTION_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "nor", "so", "yet", "of", "in",
  "on", "at", "to", "for", "with", "by", "from", "as", "into", "onto",
  "over", "under", "up", "down", "out", "off", "is", "are", "was", "were",
  "be", "been", "am", "do", "does", "did", "has", "have", "had", "will",
  "would", "can", "could", "may", "might", "must", "shall", "should",
  "i", "me", "my", "we", "us", "our", "you", "your", "he", "him", "his",
  "she", "her", "hers", "it", "its", "they", "them", "their", "who",
  "whom", "whose", "that", "this", "these", "those", "there", "here",
  "not", "no", "all", "any", "each", "every", "some", "both", "few",
  "more", "most", "than", "then", "when", "where", "why", "how", "if",
]);
const DETERMINERS = new Set([
  "the", "a", "an", "his", "her", "its", "their", "our", "my", "your",
  "this", "that", "these", "those", "some", "any", "no", "one", "each",
  "every", "another", "other", "same",
]);
const TRAILING_WORD = /[a-z']+$/;

/** Does `t` appear at least once WITHOUT an article in front of it?
 *
 *  The name/common-noun test. Scans the same haystack `scan` will, so a span
 *  already consumed by a longer name (blanked to NULs) cannot answer for this
 *  one. Twin of image_prompt._undetermined_somewhere. */
function undeterminedSomewhere(src: string, t: string): boolean {
  const pat = new RegExp(`\\b${esc(t)}\\b`, "g");
  for (let m = pat.exec(src); m; m = pat.exec(src)) {
    const w = TRAILING_WORD.exec(src.slice(0, m.index).replace(/\s+$/, ""));
    if (!(w && DETERMINERS.has(w[0]))) return true;
  }
  return false;
}

/** May this head/tail/middle be scanned for as a name? Twin of
 *  image_prompt._fragment_ok — `requireUndetermined` applies the determiner
 *  test at ANY width and the MIDDLE rule is what passes it, because a middle
 *  is the position where a common noun is likeliest to sit ("Contained Black
 *  Hole Marble"). */
function fragmentOk(t: string, src: string, requireUndetermined = false): boolean {
  if (t.length < MIN_NAME_FRAGMENT || FUNCTION_WORDS.has(t)) return false;
  if ((requireUndetermined || t.length < SHORT_FRAGMENT_MAX)
      && !undeterminedSomewhere(src, t)) return false;
  return true;
}

/** The `width`-word fragments of one split name at one END. Pure. Twin of
 *  image_prompt._name_fragments.
 *
 *  `middle` is STRICTLY interior, so a two-word name has none and a
 *  three-word name has exactly one at width 1 — which is the entire point: a
 *  head/tail pair reads "Osei Kofi" (the prose says "Osei") and reads NEITHER
 *  end of "Captain Rhea Dorne", whom the prose calls Rhea. */
export function nameFragments(parts: string[], width: number, end: string): string[] {
  if (parts.length < width) return [];
  if (end === "tail") return [parts.slice(parts.length - width).join(" ")];
  if (end === "head") return [parts.slice(0, width).join(" ")];
  const out: string[] = [];
  for (let i = 1; i < parts.length - width; i += 1) out.push(parts.slice(i, i + width).join(" "));
  return out;
}

export function featuredCast(
  text: string, names: string[], possessiveExcludes = true,
): string[] {
  let src = (text || "").toLowerCase();
  const hits: Array<[number, string]> = [];
  const possessiveOnly = new Map<string, boolean>();
  const uniq = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  // Shared by the exact pass and the head/tail fallback so the POSSESSIVE rule
  // cannot apply to one and not the other — see the Python twin.
  const scan = (needle: string): [number, boolean] => {
    const pat = new RegExp(`\\b${esc(needle)}\\b`, "g");
    let first = -1, bare = false;
    for (let m = pat.exec(src); m; m = pat.exec(src)) {
      if (first < 0) first = m.index;
      // POSSESSIVE or not — see the Python twin. "Astronaut Rei's helmet"
      // puts the helmet in frame, not her; a name that appears at least once
      // without the apostrophe is a person in the shot.
      const after = m.index + m[0].length;
      const tail = src.slice(after, after + 2);
      if (!(tail.startsWith("'s") || tail.startsWith("\u2019s"))) bare = true;
      // A possessive over a BODY PART is the person ("Villian Rei's
      // tightening face"); only a detachable object leaves them out of frame.
      else if (BODY_AFTER.test(src.slice(after + 2))) bare = true;
      // NUL, not a space — the twin blanks with NUL, and
      // `undeterminedSomewhere` trims WHITESPACE off its left context: blank
      // with spaces and a fragment sitting right after a consumed span reads
      // the determiner of the word before it instead of finding none.
      src = src.slice(0, m.index) + "\u0000".repeat(m[0].length)
          + src.slice(m.index + m[0].length);
      pat.lastIndex = m.index + m[0].length;
    }
    return [first, bare];
  };

  for (const nm of uniq) {
    const [first, bare] = scan(nm.toLowerCase());
    if (first >= 0) { hits.push([first, nm]); possessiveOnly.set(nm, !bare); }
  }

  // A character the prose calls by a COMMON NOUN ("the creature" for the
  // Fractured Reflection Creature). Only the entry's last word, and only when
  // it is unique across the cast — "Guide Rei" would otherwise reduce to
  // "rei" and swallow every mention of everyone.
  // Longest tail first — see the Python twin: "Guide Rei's Cloudy Marble"
  // appears as "one cloudy marble", and its last word alone collides with
  // "Contained Black Hole Marble".
  // …and the HEAD, under the same guards — see the Python twin. A PERSON is
  // called by the end of their name that a creature is not: the tail rule
  // finds "the creature", and looks at the wrong end for "Osei Kofi", whom
  // the prose calls "Osei". Measured on THE LAST SERVICE: 74 first-name
  // mentions across 49 shots and zero in full, so exact matching found nobody
  // and every beat silently fell back to the roster.
  //
  // …and the MIDDLE, last of the three, because a head/tail pair reads a
  // two-word name and cannot read a three-word one. A person filed with a
  // TITLE is called by the word between the ends — "Captain Rhea Dorne" and
  // "Dr. Sato Ibarra" are said as Rhea and Sato. MEASURED on SPINE_RUN /
  // SALVAGE_AWAKENING: neither matched on its own text in EITHER twin, so
  // each was staged only where the character happens to have a LINE (the
  // speaker string carries the full name into the haystack). A beat billed "a
  // medium two-shot at eye level between Rhea and Lucy" staged Lucy and JUNO
  // — named once, as the direction Rhea walks toward.
  //
  // Tails run before heads and heads before middles at each width, so a name
  // that already resolves is in `matched` and never consults the next rule:
  // nothing that works today changes. Middles are the one position that
  // carries the determiner test at every width — see `fragmentOk`.
  const matched = new Set(hits.map((h) => h[1]));
  for (const width of [2, 1]) {
    for (const end of ["tail", "head", "middle"] as const) {
      const parts_of = new Map<string, string[]>();
      for (const nm of uniq) {
        const parts = nm.toLowerCase().split(/\s+/).filter(Boolean);
        for (const t of nameFragments(parts, width, end)) {
          parts_of.set(t, [...(parts_of.get(t) ?? []), nm]);
        }
      }
      for (const [t, owners] of parts_of) {
        if (owners.length !== 1 || matched.has(owners[0])
            || !fragmentOk(t, src, end === "middle")) continue;
        const [first, bare] = scan(t);
        if (first >= 0) {
          hits.push([first, owners[0]]);
          // Possessives bind on a HEAD and not on a TAIL — the people/objects
          // distinction this function already draws. "the photograph's corner"
          // is part of the photograph; "Osei's watch" is not part of Osei. A
          // MIDDLE binds for the head's reason: it is a given name.
          possessiveOnly.set(owners[0], end !== "tail" ? !bare : false);
          matched.add(owners[0]);
        }
      }
    }
  }

  // See the Python twin: the possessive rule is about PEOPLE. An object's
  // possessive ("the photograph's corner") is a part of that object.
  return hits.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1))
    .map((h) => h[1])
    .filter((nm) => !possessiveExcludes || !possessiveOnly.get(nm));
}

/** Things a voice arrives THROUGH. Twin of image_prompt._VOICE_DEVICE —
 *  deliberately short and concrete: "line" and "call" are left out because a
 *  shop full of clocks has lines and a scene can call for anything, and a
 *  false positive here deletes a character who really is in the room. */
const VOICE_DEVICE = new RegExp(
  "\\b(phone|telephone|mobile|cell ?phone|handset|receiver|speakerphone|"
  + "speaker|intercom|radio|tannoy|headset|earpiece|voicemail|answering "
  + "machine|video ?call|monitor|screen)\\b", "i");

/** Does this ONE name appear as a body in this text? Twin of
 *  image_prompt._appears_in_frame.
 *
 *  Asked per name rather than by running `featuredCast` over the whole cast,
 *  because that function's fallback is guarded for scanning a whole roster (a
 *  fragment must be unique across the cast and survive the function-word and
 *  determiner tests). The question here is narrower — "is this specific
 *  person in the shot" — and the EXACT pass carries no such guards, so
 *  handing it the name's own forms one at a time gets the possessive rule
 *  applied to a name the roster scan would have refused.
 *
 *  EVERY part is a form, not just the ends: "Captain Rhea Dorne" is called
 *  Rhea, and with only {first, last} this reports her absent from a shot that
 *  plainly names her — which here deletes a character standing in the room. */
function appearsInFrame(text: string, name: string): boolean {
  const parts = String(name || "").split(/\s+/).filter(Boolean);
  const forms = new Set<string>([name, ...(parts.length > 1 ? parts : [])]);
  return featuredCast(text, [...forms].filter(Boolean)).length > 0;
}

/** Who SPEAKS in this beat without being in it. Pure. Twin of
 *  image_prompt.remote_speakers, and it was missing from this twin entirely.
 *
 *  A character on the other end of a phone has no body in the shot. Left
 *  uncounted, the speaker counts as FEATURED (their line is part of the text
 *  the matcher reads), so they are staged as `<Picture N>`, given a subject
 *  definition, and given a physical position — MEASURED on THE LAST SERVICE
 *  b0, where H3 duly drew a woman who is only ever a voice on a call.
 *
 *  Conservative on purpose: nobody is returned when there is no device word,
 *  because deleting a character who IS in the room is far worse than drawing
 *  one who is not — the shot loses its second face and the model invents one.
 *
 *  The caller passes the shot's own text WITHOUT the speaker string, or a
 *  name would be its own evidence of being in frame. */
export function remoteSpeakers(
  text: string, castNames: string[], speakers: Array<string | null | undefined>,
): string[] {
  const txt = String(text || "");
  if (!VOICE_DEVICE.test(txt)) return [];
  const spoke = new Set((speakers || []).map((x) => String(x ?? "").trim()).filter(Boolean));
  if (!spoke.size) return [];
  return (castNames || []).filter((n) => spoke.has(n) && !appearsInFrame(txt, n));
}

/** Reference order for one panel -> [ordered, locationFirst]. Pairs stay
 *  paired so `[REFERENCES]` keeps describing the right picture. */
export function orderAnchors<T>(
  camera: string, faces: T[], env: T | null, facesWhenWide = 1,
): [T[], boolean] {
  if (env && locationLeads(camera)) return [[env, ...faces.slice(0, facesWhenWide)], true];
  return [[...faces, ...(env ? [env] : [])], false];
}

/** The planner's own fallback (worker/llm.py, `project.style or "anime"`).
 *  Kept identical on purpose — see panelDefaults. */
export const PLANNER_STYLE_FALLBACK = "anime";

/** The `prompt_spec` + anchors for one shot, exactly as worker/llm.py builds
 *  them. Exported so a caller can show what it is about to queue.
 *
 *  `sceneBeats` is the whole scene, in order, and is required rather than
 *  optional: the location-plate rotation counts only the shots that rotate, so
 *  it cannot be derived from one beat — and a fallback that guessed from
 *  `beat.idx` would put a scene's two wides back on the same plate, silently,
 *  which is the exact bug this fixes. */
export function panelSpec(scene: Scene, beat: Beat, ctx: PanelCtx, sceneBeats: Beat[]) {
  const place = scene.environment_id
    ? ctx.bible.find((b) => b.id === scene.environment_id) ?? null : null;
  const sceneCast = (scene.cast_ids ?? [])
    .map((id) => ctx.bible.find((b) => b.id === id)).filter(Boolean) as BibleEntry[];

  // Beats name a character by first name, and an outfit variant shares its
  // parent's ("Aki Minase" / "Aki Minase — Print-shop uniform"), so a lookup
  // over the whole bible is a collision: whichever row came back last wins,
  // and half the time that is a variant the scene never cast. The scene's own
  // cast is resolved first and the rest of the bible only fills gaps.
  // A beat names a character by BASE name ("Villian Rei") or by the FULL
  // variant name the bible files them under ("Villian Rei — Glitching capture
  // coat"), and the cinematographer writes both — sometimes in one scene. This
  // was a base-keyed MAP read with the raw name, so every full-form beat
  // matched nobody: `named` came back empty, `featuredCast` had no roster to
  // match the shot text against (it can only ever constrain someone, never
  // introduce them), and the panel fell through to `sceneCast.slice(0, 1)` —
  // the scene's FIRST cast member, who is routinely not in the shot.
  //
  // Measured on Rei EP04 CITY_CAPTURE_2 b1/b2, whose cast is Villian Rei and
  // Astronaut Rei: both staged GUIDE REI's sheet, and both came back with her
  // brown jacket,
  // while Villian Rei, staged nowhere, was drawn from prose. Nothing errored —
  // the fallback is a legal path, and it exists for the beat that casts by
  // pronoun, which is why this went unnoticed.
  //
  // The ORDER is the whole care here, and it is `blocks.py::_cast_entry_id`'s:
  // the SCENE's cast outranks the rest of the bible, because the scene's pick
  // is this scene's wardrobe — resolving a base name against the project would
  // stage the parent's sheet for a scene that deliberately cast the variant.
  // Exact before base within each, so nothing that resolves today changes.
  // Twin of llm.scene_panel_specs._cast_row.
  const sceneChars = sceneCast.filter((e) => e.kind === "character");
  const bibleChars = ctx.bible.filter((e) => e.kind === "character");
  const resolveCast = (raw: string): BibleEntry | undefined => {
    const full = String(raw).toLowerCase();
    const base = firstName(String(raw)).toLowerCase();
    const pick = (rows: BibleEntry[]) =>
      rows.find((e) => e.name.toLowerCase() === full)
      ?? rows.find((e) => firstName(e.name).toLowerCase() === base);
    return pick(sceneChars) ?? pick(bibleChars);
  };

  // Anchor on the people the SHOT'S OWN TEXT puts in frame, not the beat's
  // cast list — `meta.cast` is the cinematographer's roster, its contract
  // already says "ONLY the characters visibly in frame", and the model writes
  // the roster anyway (ASTRONAUT_CAPTURE put all five names on every beat, so
  // a close-up staged five references and montaged). `featuredCast` decides
  // staging from camera + action + who speaks; the roster survives as the
  // fallback for a beat that casts by pronoun.
  //
  // The order is the matcher's mention order, which is also the slot-1 fix:
  // image1 carries the high token budget in both reference encoders, and
  // `meta.cast` lists the lead first in essentially every beat — whoever the
  // camera or action names first gets the conditioning.
  const named = ((beat.meta?.cast ?? []) as string[])
    .map(resolveCast)
    .filter(Boolean) as BibleEntry[];
  const rowByBase = new Map<string, BibleEntry>();
  for (const c of named) {
    const key = firstName(c.name).toLowerCase();
    if (!rowByBase.has(key)) rowByBase.set(key, c);
  }
  // A speaker counts as featured in the shot carrying their line — except a
  // line marked `offscreen`, the DP's V.O. cutaway: the panel for that beat
  // shows the listener or the insert, and counting the voice would put its
  // speaker's face on it. Twin of llm.scene_panel_specs.
  const speakers = (beat.dialogue ?? [])
    .filter((d) => !d?.offscreen)
    .map((d) => d?.speaker ?? "").join(" ");
  let feat = featuredCast(
    `${beat.camera ?? ""} ${beat.action ?? ""} ${speakers}`,
    [...rowByBase.keys()],
  ).map((n) => rowByBase.get(n.toLowerCase())!);
  // A voice on the far end of a phone is not in the panel either, and it is
  // `speakers` above that drags them in: a speaker counts as featured, which
  // is right for someone in the room and wrong for a caller. Same detector as
  // the planner and the block staging, on the shot's own text — with the
  // speaker string deliberately EXCLUDED, or the name would be its own
  // evidence of being in frame. This twin had no such rule at all, so it
  // staged a character sheet for a phone call where the planner dropped it.
  const remote = new Set(remoteSpeakers(
    `${beat.camera ?? ""} ${beat.action ?? ""}`,
    feat.map((c) => firstName(c.name)),
    (beat.dialogue ?? []).map((d) => d?.speaker)));
  if (remote.size) feat = feat.filter((c) => !remote.has(firstName(c.name)));

  // A beat that names nobody still gets the scene's lead, or the panel invents
  // a face — same fallback the planner applies.
  //
  // The cap follows the render FAMILY (twin of image_prompt.panel_cast_cap):
  // H3 takes nine references where Krea 2 takes four and Qwen three, and the
  // flat cap of two is what put invented extras into finished panels — the
  // third cast member stayed in the action prose with no sheet, and the model
  // drew them from words alone. `cast_complete` records that nobody was
  // dropped, which is what licenses the envelope's "no other people" close.
  const cap = panelCastCap(ctx.imageModel);
  let present: BibleEntry[];
  if (beat.meta?.breath) {
    // A breath beat is a held pause on the staging just seen. Its action is
    // our own filler ("no one speaks and nothing new enters the frame") and
    // gives the model no composition, so staged identity sheets become the
    // strongest signal in the job and the panel comes back AS a sheet —
    // measured on ASTRONAUT_CAPTURE b7, grey ground and all. What these
    // beats show is the PLACE. (The planner skips their panel jobs entirely;
    // a manual redraw through here composes the location alone.)
    present = [];
  } else if (feat.length) {
    // ALL the featured, close shots included. A close-up-stages-one rule was
    // tried here and lost the same day it shipped: dropping the action-named
    // second character re-invited the invented-extra artifact (an off-model
    // masked "Astronaut Rei", a Villian in an invented white shirt — both
    // drawn from prose because their sheets were withheld). The part that was
    // right — the camera's subject in image1 — falls out of mention order for
    // free, because the camera text leads the matcher's input.
    present = feat.slice(0, cap);
  } else {
    present = named.length ? named.slice(0, cap) : sceneCast.slice(0, 1);
  }

  // The third slot is what the H3 envelope binds `<Subject N>` to. It rides
  // with the label so it cannot fall out of step with the staged ORDER, which
  // is the one thing `<Picture N>` numbering cannot get wrong.
  type Pair = [{ entry_id: string; roles: string[]; first?: true }, string, RefSubject];
  const facePairs: Pair[] = present.map((c) => {
    return [characterAnchor(c), `${firstName(c.name)}'s character sheet`,
            { kind: "character" as const, name: firstName(c.name),
              identity: c.identity_line }];
  });
  // Which plate this shot stages. Solved across the whole scene because the
  // rotation's turn counter is per scene; `first` makes the list a preference
  // order rather than a set, or one location would eat three slots.
  const at = Math.max(0, sceneBeats.findIndex((b) => b.id === beat.id));
  // `plate_turn` is STAMPED on the scene by the planner and read here rather
  // than recomputed — a redraw sees one scene and cannot count the ones before
  // it, so a locally-derived turn would disagree with what actually rendered.
  // Absent (a board planned before the stamp) it is 0, i.e. exactly the old
  // per-scene restart.
  const plates = platePlan(sceneBeats.map((b) => b.camera ?? ""),
                           Number((scene.meta as { plate_turn?: number } | null
                                   | undefined)?.plate_turn ?? 0));
  const plate = place ? (plates[at] ?? [...PLATE_RING])[0] : null;
  const envPair: Pair | null = place
    ? [{ entry_id: place.id, roles: plates[at] ?? [...PLATE_RING], first: true },
       // WHICH place, never which plate: the plate can still fall back, and a
       // label naming a picture that was not staged is worse than none. The
       // plate wording is composed from `spec.plate`, which handle_image_gen
       // corrects to whatever actually resolved.
       `${/^the /i.test(place.name) ? "" : "the "}${place.name} location`,
       { kind: "location", name: place.name, identity: place.identity_line }]
    : null;

  // On a wide/establishing/full shot the LOCATION takes image1 and at most one
  // face rides along. Twin of image_prompt.order_anchors — measured: a "wide
  // establishing … through the black water" beat rendered as an eye-level
  // medium two-shot with no water, because two face plates held the slots that
  // carry the token budget and the model composed the people it was handed.
  // Pairs stay paired: [REFERENCES] names each picture by its number.
  // …and on a wide the LOCATION leads with at most `wideFaceCap` faces behind
  // it. One is a slot-budget rule from the four-image families; on a ten-slot
  // model it drops a character the action prose still names.
  const [ordered] = orderAnchors(beat.camera ?? "", facePairs, envPair,
                                 wideFaceCap(ctx.imageModel));
  // Completeness is judged on what the SHOT CLAIMS to show, against what
  // ordering kept: a wide drops faces to one deliberately, and claiming "no
  // other people" while the action names three tells the model two
  // contradictory things about the same frame. When the text features a
  // subset of the roster, that subset IS the claim — the other roster members
  // are asserted out of frame. Twin of the planner's rule.
  const claim = feat.length ? feat : named;
  const stagedFaces = ordered.filter((p) => p[2]?.kind === "character").length;
  const castComplete = claim.length > 0 && claim.length <= cap
    && stagedFaces === claim.length;
  const anchors = ordered.map((p) => p[0]);
  const refs = ordered.map((p) => p[1]);
  const ref_subjects = ordered.map((p) => p[2]);

  const spec = {
    kind: "panel",
    style: ctx.style,
    // the WHOLE camera line: image_prompt.shot_framing() pulls size and angle
    // out of it and drops the motion grammar, which means nothing in a still.
    // Passing only the first clause threw away the angle.
    camera: beat.camera ?? "",
    action: beat.action,
    time_of_day: (scene.meta?.time as string) ?? null,
    // What ORDERING KEPT, never `present` — twin of llm.scene_panel_specs,
    // which fixed this first and left the browser behind. `orderAnchors` drops
    // faces on a wide (the location takes image1 and at most `wideFaceCap`
    // ride along), and DESCRIBING a character the render was handed no picture
    // of is worse than either being wrong alone: measured on MEMORY_RETURN b1,
    // where the envelope read "<Subject 2> (Guide Rei) and Miko and Knight
    // Rei" over two references, so two of the three named people had no sheet
    // and H3 invented them. `castComplete` already followed the ordering; this
    // did not.
    cast: ordered.filter((p) => p[2]?.kind === "character")
      .map((p) => ({ name: p[2].name, identity: p[2].identity })),
    location: place ? { name: place.name, identity: place.identity_line } : null,
    // Which plate is staged. Present ONLY when one is: it is what switches the
    // framing from a description into a camera-move imperative, which is the
    // difference between a new vantage and a copy of the plate.
    ...(plate ? { plate } : {}),
    refs,
    ref_subjects,
    // Licenses the H3 envelope's "no other people appear" close-out; absent
    // when a cast name was dropped by the cap, because then the claim would
    // contradict the action prose that still names them.
    ...(castComplete ? { cast_complete: true } : {}),
  };
  return { spec, anchors };
}

/** How many face sheets a panel may stage — twin of
 *  image_prompt.panel_cast_cap, see the long note there. Substring match on
 *  purpose: the browser holds the catalog id ("h3-image-turbo-local"), the
 *  planner the model_map key ("h3-image-turbo"), and both must agree. */
export function panelCastCap(modelKey: string | null | undefined): number {
  return /h3|sensenova/i.test(modelKey ?? "") ? 4 : 2;
}

/** How many faces ride along when the LOCATION leads a wide — twin of
 *  image_prompt.wide_face_cap, see the long note there. The default of ONE is
 *  a slot-budget rule from the four-image families; on a ten-slot model it
 *  drops a character who is still named in the action prose, and the model
 *  draws them from words. */
export function wideFaceCap(modelKey: string | null | undefined): number {
  return /h3|sensenova/i.test(modelKey ?? "") ? 4 : 1;
}

/**
 * The scene's KEY STILL — the one establishing frame the card shows.
 *
 * It used to be composed by hand from `scene_prompt` plus `ref_asset_ids`
 * picked by a role-BLIND lookup: "lowest slot, first row wins", over a bible
 * where a character's face / full_body / turnaround all sit at slot 0 and a
 * location's master / alt_angle / detail / atmosphere do too. So the anchor
 * for a person was as likely to be the six-view turnaround GRID as her face
 * plate, and a location's only reference was as likely to be a `detail`
 * close-up as its master — the same failure blocks.py already documents and
 * fixes with `slot=lt.90` plus an explicit role. The prompt was equally thin:
 * one line of scene prose, with nobody named and nothing said about what
 * happens.
 *
 * So it goes through the panel machinery instead. Anchors become late-bound
 * `{entry_id, roles}` — `face` for a person, `master` for a place, resolved on
 * the pod — and the spec carries the cast, the location and the action, which
 * is what `[LOCKED CHARACTER]` / `[LOCKED LOCATION]` / `[REFERENCES]` need.
 * One generator, exactly as `queueBeatPanel` and the planner already share one.
 *
 * The camera is stated as an establishing wide because that is what a key still
 * IS, and it earns its keep twice: `orderAnchors` then puts the LOCATION in
 * image1, where the token budget lives, instead of a face — measured as the fix
 * for wides that came back as medium two-shots with no environment in them.
 */
const STILL_CAMERA = "wide establishing shot, eye level";

export function sceneStillSpec(scene: Scene, ctx: PanelCtx) {
  const place = scene.environment_id
    ? ctx.bible.find((b) => b.id === scene.environment_id) ?? null : null;
  const cast = (scene.cast_ids ?? [])
    .map((id) => ctx.bible.find((b) => b.id === id))
    .filter((e): e is BibleEntry => !!e && e.kind === "character")
    // Two faces is the panel ceiling for the same reason: past that the
    // reference encoder is composing a line-up rather than a frame.
    .slice(0, 2);

  // The third slot is what the H3 envelope binds `<Subject N>` to. It rides
  // with the label so it cannot fall out of step with the staged ORDER, which
  // is the one thing `<Picture N>` numbering cannot get wrong.
  type Pair = [{ entry_id: string; roles: string[]; first?: true }, string, RefSubject];
  const facePairs: Pair[] = cast.map((c) => {
    return [characterAnchor(c), `${firstName(c.name)}'s character sheet`,
            { kind: "character" as const, name: firstName(c.name),
              identity: c.identity_line }];
  });
  const envPair: Pair | null = place
    ? [{ entry_id: place.id, roles: ["master"] },
       `${/^the /i.test(place.name) ? "" : "the "}${place.name} location, its master plate`,
       { kind: "location", name: place.name, identity: place.identity_line }]
    : null;
  // `facesWhenWide` is 2 here where a beat panel uses 1, and the difference is
  // deliberate. On a beat, a wide is ONE shot with one subject, and the measured
  // failure was two face plates holding image1/image2 and turning "wide
  // establishing … through the black water" into a medium two-shot with no
  // water. A key still is the scene's ensemble frame — a two-hander whose still
  // anchors only one of its leads leaves the other's identity to the prose,
  // which is the drift this whole path exists to prevent. The fix that mattered
  // is keeping the LOCATION in image1, which it still does; three references is
  // inside the Krea2EditRebalance ceiling of four. Not separately measured —
  // if stills start coming back as two-shots, this is the number to try at 1.
  const [ordered] = orderAnchors(STILL_CAMERA, facePairs, envPair, 2);

  const spec = {
    kind: "panel",
    style: ctx.style,
    camera: STILL_CAMERA,
    // What actually happens here. `scene_prompt` is the writer's own line for
    // the scene; the slug alone ("THE-LOOP") describes nothing.
    action: scene.scene_prompt || scene.slug || "the scene",
    time_of_day: (scene.meta?.time as string) ?? null,
    cast: cast.map((c) => ({ name: firstName(c.name), identity: c.identity_line })),
    location: place ? { name: place.name, identity: place.identity_line } : null,
    refs: ordered.map((p) => p[1]),
  };
  return { spec, anchors: ordered.map((p) => p[0]) };
}

/** How many alternates one click offers. Matches the worker's PANEL_ALTS_KEPT
 *  ceiling so a single round can never overflow the list it writes into. */
export const PANEL_ALTS = 5;

/** A seed to start a round of alternates from.
 *
 *  Derived from the beat id plus how many alternates it already has, so a
 *  second click on the same shot explores new seeds rather than re-rendering
 *  the first five. Kept small and positive — some samplers reject negatives,
 *  and ComfyUI's seed widgets are bounded. */
export function seedBase(beat: Beat): number {
  const id = String(beat.id ?? "");
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 1_000_003;
  const already = (beat.meta?.panel_alts as string[] | undefined)?.length ?? 0;
  return h * 16 + already + 1;
}

/** The worker's bound for `panel_alts` — `handlers/images.py::PANEL_ALTS_KEPT`.
 *  (panelSpec's PANEL_ALTS = 5 is a different number: how many one click
 *  OFFERS, not how many a beat KEEPS.) */
export const PANEL_ALTS_KEPT = 8;

/** The beat meta a landed picture produces — the twin of
 *  `handlers/images.py::beat_meta_after`, pinned against it by
 *  `hostedRender.test.ts`. Every branch is silent when wrong: a panel written
 *  into the still slot outranks the user's own pick, and an alternate written
 *  into the panel slot is a round of rolls overwriting itself.
 *
 *  A REPLACED PANEL IS KEPT. A single-roll redraw overwrites
 *  `panel_asset_id`, so the picture it replaces used to leave the beat
 *  entirely and the redraw modal's rail read "0 alternates" however many times
 *  you redrew. The file is never deleted and the list is bounded, so keeping
 *  the id costs nothing and makes going back one click instead of a hunt
 *  through the library. Skipped when the panel is unchanged, or a repeat
 *  would fill the list with one picture. */
export function beatMetaAfter(
  meta: Record<string, unknown>, assetId: string, as: string | undefined,
): Record<string, unknown> {
  const out = { ...meta };
  const alts = ((out.panel_alts as string[] | undefined) ?? [])
    .filter((a) => typeof a === "string");
  const keep = (id: string) => {
    if (!alts.includes(id)) alts.push(id);
    out.panel_alts = alts.slice(-PANEL_ALTS_KEPT);
  };
  if (as === "panel_alt") { keep(assetId); return out; }
  if (as === "panel") {
    const prev = out.panel_asset_id;
    out.panel_asset_id = assetId;
    if (typeof prev === "string" && prev && prev !== assetId) keep(prev);
    return out;
  }
  out.still_asset_id = assetId;
  return out;
}

/** What promoting an alternate does to a beat's meta. Pure, so the precedence
 *  rule is testable without a database.
 *
 *  The alternates list is deliberately left intact: the others are still valid
 *  offers, and someone who dislikes this pick should be able to take a
 *  different one without re-rendering anything.
 *
 *  It writes `panel_asset_id`, never `still_asset_id` — a promoted alternate is
 *  still auto material and must keep losing to a still a human designated
 *  (`beatImageId`, and the ref plan behind it). The one wrinkle that follows:
 *  on a beat that HAS a user still, promoting changes what renders but not what
 *  the strip shows, so the caller surfaces that rather than looking broken. */
export function panelChoiceMeta(beat: Beat, assetId: string): Record<string, unknown> {
  // Through `beatMetaAfter`, so promoting obeys the same rule a landed redraw
  // does — including keeping the panel it replaces. The one being promoted is
  // usually in the list already; the one it displaces need not be (a redraw
  // put it there without ever passing through this list), and losing it here
  // would be the same one-way door in a second place.
  return beatMetaAfter((beat.meta ?? {}) as Record<string, unknown>, assetId, "panel");
}

/**
 * What putting a picture of your OWN on a shot does to its meta — the twin of
 * `panelChoiceMeta`, on the other slot. Pure for the same reason: these two
 * functions are the whole precedence rule, and it is worth being able to check
 * without a database.
 *
 * It writes `still_asset_id`, the DELIBERATE slot, whatever the picture came
 * from — uploaded, or chosen out of the library. That is what makes choosing
 * one safe: "Re-draw panels" rewrites `panel_asset_id` for a whole scene in
 * one click, so a chosen picture landing in the auto slot would be destroyed
 * by a button two rows away. The drawn panel underneath is left alone, so
 * removing this pick falls back to it (`beatImageId`).
 *
 * AND IT DROPS A START FRAME THAT NAMED THE PICTURE BEING REPLACED.
 * `start_frame_asset_id` is a second id the worker reads on its own, and the
 * only thing that ever sets it is the role segment, which sets it to whatever
 * is in the slot. So replacing the picture and leaving it behind renders a
 * block that OPENS on the old image while every surface shows the new one —
 * silent, because both ids are valid and neither contradicts the other.
 * Clearing the slot has always done this; setting it never did.
 */
export function beatStillMeta(beat: Beat, assetId: string): Record<string, unknown> {
  const prev = beat.meta?.still_asset_id as string | undefined;
  const meta: Record<string, unknown> = {
    ...(beat.meta ?? {}), still_asset_id: assetId,
  };
  if (prev && beat.meta?.start_frame_asset_id === prev) meta.start_frame_asset_id = null;
  return meta;
}

/** The picture a beat shows, and what it IS — the precedence is the ref
 *  plan's, so every surface agrees with the render. */
export function beatImageId(beat: Beat): { id: string | null; kind: "still" | "panel" | null } {
  const still = beat.meta?.still_asset_id as string | undefined;
  if (still) return { id: still, kind: "still" };
  const panel = beat.meta?.panel_asset_id as string | undefined;
  if (panel) return { id: panel, kind: "panel" };
  return { id: null, kind: null };
}

// The REFERENCE-SHEET prompt, composed in the browser — twin of the prose
// branch of `compose()` in `worker/image_prompt.py`.
//
// WHY THIS EXISTS, and why it is a second file rather than more of
// panelPrompt.ts. The `hosted` edge function moved the studio's keys off the pod,
// and `enqueueJob` reroutes a studio-hosted image job to `lane: "local"` —
// but ONLY when the payload is FINISHED (a literal `prompt` plus explicit
// `ref_asset_ids`). Anything carrying `prompt_spec` composes in Python and
// therefore stays on the pod's gpu lane, whatever the model.
//
// `panelPrompt.ts` closed that for PANELS. It did not close it for SHEETS, and
// sheets are the other half of the same problem: every "generate a plate /
// turnaround / prop reference" button in the app sends `prompt_spec`, so
// picking GPT Image 2 for a character's alt-angle plate queued a job whose
// entire pod contribution was an HTTPS call and a B2 upload — $3.36/hr to run
// a curl, and a stopped pod meant the job simply waited.
//
// Panels are a DIFFERENT branch of the Python (`_panel_prose`, off the top of
// `compose`), so sharing a file would mean one module holding two unrelated
// contracts; they share the small primitives (`clean`, `PROSE_FAMILIES`) and
// nothing else.
//
// ONLY THE PROSE BRANCH IS PORTED, the same decision panelPrompt.ts made and
// for the same reason: the bracketed comma "stack" belongs to the SDXL-family
// models, which are local and need the pod anyway. Every family this can
// render for (`openai`, `google`) reads sentences. A family this cannot
// compose for is REFUSED, never silently handed the wrong dialect.
//
// IT IS A TWIN, so it is pinned like one: `scripts/gen_sheet_golden.py` emits
// real specs through the Python and commits the strings, and
// `sheetPrompt.test.ts` asserts this file reproduces them BYTE FOR BYTE. The
// failure a hand-written parity test cannot see is a sheet that renders
// perfectly well and differs from the one the pod would have drawn — after
// which the character's identity anchor depends on which machine drew it.
import { clean, PROSE_FAMILIES } from "./panelPrompt.ts";

// ── the tables, transcribed from image_prompt.py ───────────────────────────

/** Twin of `FRAMING`. A slot's framing, for the t2i case where no reference
 *  is carrying it. */
const FRAMING: Record<string, string> = {
  still: "cinematic frame, 16:9",
  face: "tight face portrait filling the frame, front view, neutral "
    + "expression, hair fully visible, no shoulders",
  full_body: "full-body shot, standing in a neutral pose, front view",
  side: "full-body profile view",
  outfit: "waist-up, wardrobe clearly visible",
  turnaround: "character turnaround reference sheet, a 2x3 grid of six "
    + "views of the SAME person, thin white gutters separating "
    + "the cells, reading left-to-right top-to-bottom — "
    + "view 1: front full-body standing relaxed; view 2: back "
    + "full-body same stance; view 3: left profile full-body; "
    + "view 4: right three-quarter full-body; view 5: face "
    + "close-up front; view 6: face close-up right "
    + "three-quarter — identical face, hair, build and wardrobe "
    + "in every view",
  master: "wide establishing shot at eye level",
  alt_angle: "wide shot from the opposite side of the space, reverse angle",
  detail: "close-up on the surfaces, materials and dressing at chest height",
  atmosphere: "wide shot filled with the air of the place",
};

/** Twin of `image_prompt.ENVIRONMENT_ROLES`. Also in panelPrompt.ts, where it
 *  serves the plate correction — kept separate rather than cross-imported so
 *  each file transcribes the constant it actually uses. */
const ENVIRONMENT_ROLES = ["master", "alt_angle", "detail", "atmosphere"];

/** Twin of `ENVIRONMENT_MOVE`. A plate drawn FROM a master needs an
 *  INSTRUCTION TO MOVE THE CAMERA, not a description of a picture: measured,
 *  a descriptive framing behind an identity line got the reference reproduced
 *  (luma correlation 0.895 / 0.853 / 0.578 against the plate it derives from).
 *  This is the whole reason a hosted plate must not fall back to a hand-rolled
 *  "environment reference, alt angle" — that prompt is the failure, spelled
 *  out. */
const ENVIRONMENT_MOVE: Record<string, string> = {
  alt_angle: "Rotate the camera around this location to the opposite side "
    + "and show the reverse angle. I want an entirely new vantage on "
    + "the same place — reveal what was behind the first view, with "
    + "the architecture and dressing already established staying "
    + "recognisably the same place.",
  detail: "Move the camera in extremely close on ONE specific surface of "
    + "this location — its materials, wear and dressing at arm's "
    + "length, macro detail. Not the wide view: pick a single part of "
    + "it and fill the frame with that.",
  atmosphere: "Hold this location and change only the air in it: the same "
    + "place, re-lit by its own signature light, haze and depth "
    + "carrying the mood. Move the camera enough that this reads "
    + "as a different frame of the place, not the same one.",
};

/** Twin of `CHARACTER_MOVE`: the same problem on the character side. A crop
 *  taken from a reference drops the identity paragraph — a knight's identity
 *  line is a description of a standing figure WITH EQUIPMENT, so behind a
 *  "tight face portrait" it does not merely sit in front of the crop, it
 *  argues with it. */
const CHARACTER_MOVE: Record<string, string> = {
  face: "Crop in tight on this character's FACE and fill the frame with it "
    + "— head only, front view, neutral expression, hair fully visible, "
    + "cropped at the neck. Not the standing figure: this is a portrait "
    + "of the head, and nothing they are wearing or carrying below the "
    + "collar is in shot.",
  side: "Turn this character to a full profile and show them from the side "
    + "— one clean side-on view, head to feet, same person, same "
    + "wardrobe.",
};

/** Twin of `FACE_MOVE`: the t2i face plate, where the prose cannot be dropped
 *  (no picture is carrying the identity) so it is TRIMMED instead. */
const FACE_MOVE = "A tight head-and-hair portrait that fills the frame, front view, "
  + "neutral expression, cropped at the neck";

/** Twin of `_BELOW_COLLAR`. Consulted only to DROP, so a miss costs a word
 *  and never a person. */
const BELOW_COLLAR = [
  "jacket", "coat", "shirt", "blouse", "tie", "hoodie", "hood", "tabard",
  "suit", "trousers", "jeans", "skirt", "dress", "sweater", "jumper",
  "cardigan", "vest", "waistcoat", "tunic", "uniform", "overall", "apron",
  "boots", "shoes", "trainers", "sneakers", "sandals", "socks",
  "belt", "trouser", "sleeve", "collar", "pocket", "lanyard", "badge",
  "bag", "case", "satchel", "backpack", "holding", "carrying", "clipboard",
  "watch", "bracelet", "ring", "nail", "nails", "thumbnail", "fingernail",
  "gloves", "gauntlet", "greaves", "armour", "armor", "shield", "sword",
  "cloak", "cape", "robe", "mail", "chestplate", "breastplate",
  "build", "frame", "figure", "physique", "shoulders", "torso", "waist",
];

const CHARACTER_LIGHT = "even neutral studio key light from the front";
const CHARACTER_GROUND = "plain seamless mid-grey backdrop";
const PROP_LIGHT = "even flat lighting that shows its form and materials clearly";
const PROP_GROUND = "plain mid-grey background";
const ENVIRONMENT_LIGHT = "motivated natural light";
const ENVIRONMENT_LIGHT_BY_ROLE: Record<string, string> = {
  detail: "raking motivated light across the materials",
  atmosphere: "the location's own signature light, haze in the air",
};
const ENVIRONMENT_SUBJECT = "the location alone, architecture and props only";
/** Terminal and cap-exempt in the Python, and terminal here. It names what is
 *  NOT in frame where `ENVIRONMENT_SUBJECT` names what is — the two argue from
 *  both sides, which is what finally stopped plates growing pedestrians. */
const ENVIRONMENT_EMPTY = "The place stands completely empty of people — no person, "
  + "no figure, no crowd, no silhouette anywhere in the frame";

// ── the small string rules ────────────────────────────────────────────────

/** Twin of `face_identity`: an identity line trimmed to what a HEAD PORTRAIT
 *  can show. Anything unrecognised is KEPT — the point is to remove the
 *  clauses that argue for a standing figure, not to curate the description. */
export function faceIdentity(identity: unknown): string {
  const text = clean(identity);
  if (!text) return text;
  const kept: string[] = [];
  for (const clause of text.split(/,\s*/)) {
    const c = clause.trim();
    if (!c) continue;
    const bare = c.replace(/^(and|with|wearing|in)\s+/i, "");
    if (BELOW_COLLAR.some((t) => new RegExp(`\\b${t}s?\\b`, "i").test(bare))) continue;
    kept.push(c);
  }
  // Everything looked like wardrobe: keep the line rather than send a prompt
  // with no person in it.
  if (!kept.length) return text;
  return kept.join(", ").replace(/,\s*and\s*$/, "").replace(/[, ]+$/, "");
}

/** Twin of `_style_clause`, prose shape only. "consistent character design"
 *  is the point of a character sheet and nonsense on a location. */
function styleClause(style: unknown, kind: string): string {
  const consistency = kind === "character" ? "consistent character design" : "coherent art direction";
  const s = clean(style);
  if (!s) return `${consistency}, high detail`;
  return `Rendered in ${s} style, with ${consistency} and high detail.`;
}

/** Python's `re.escape` for the one place a spec value reaches a pattern. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── the composer ──────────────────────────────────────────────────────────

export interface SheetSpec {
  kind?: unknown;
  role?: unknown;
  name?: unknown;
  identity?: unknown;
  style?: unknown;
  note?: unknown;
  reads?: unknown;
  depicts?: unknown;
  sited?: unknown;
  from_ref?: unknown;
  world?: { era?: unknown; palette?: unknown; style_notes?: unknown; vfx_language?: unknown } | unknown;
  [k: string]: unknown;
}

/** The kinds this file composes. `panel` and `scene_grid` take other branches
 *  of the Python entirely — `panel` is `panelPrompt.ts`, and `scene_grid` is
 *  the retired storyboard grid, which is default-off and never queued from a
 *  browser. */
export const SHEET_KINDS = ["character", "environment", "prop", "scene"] as const;

/**
 * Twin of the prose path through `compose()`.
 *
 * `spec = {kind, role, identity, name, style, note, world}` — the same object
 * the pod is sent, so a caller composes early by handing over exactly what it
 * would otherwise have put in `prompt_spec`.
 */
export function sheetProse(spec: SheetSpec): string {
  const s = spec && typeof spec === "object" ? spec : {};
  const kind = clean(s.kind) || "character";
  let role = clean(s.role) || (kind === "environment" ? "master" : "full_body");
  const identity = clean(s.identity);
  const name = clean(s.name);
  const note = clean(s.note);
  const world = (s.world && typeof s.world === "object" ? s.world : {}) as
    { era?: unknown; palette?: unknown; style_notes?: unknown; vfx_language?: unknown };

  // A slot from the other kind's sheet is not a framing this kind can use:
  // fall back to its own default rather than shooting a location full-body.
  const defaultRole = kind === "environment" ? "master" : "full_body";
  if (kind === "environment" && !ENVIRONMENT_ROLES.includes(role)) role = defaultRole;
  const framing = FRAMING[role] ?? FRAMING[defaultRole];

  let parts: string[];
  if (kind === "scene") {
    // A designed frame for one moment: whatever it depicts is the subject,
    // people included, so neither the empty-location line nor the studio
    // backdrop applies.
    parts = [identity || name || "a cinematic moment",
             FRAMING[role] ?? FRAMING.still, ENVIRONMENT_LIGHT];
  } else if (kind === "prop") {
    // A prop is an OBJECT, and NOTHING here names a medium — only the style
    // clause does. Naming a photographic SETUP specifies a medium just as
    // surely as naming the medium did (measured: three variants, same seed).
    const subject = identity || name || "a hand prop";
    const reads = clean(s.reads);
    const depicts = clean(s.depicts);
    if (s.sited) {
      // A prop fixed to a location has to be shown THERE — on grey it says
      // nothing about where it hangs.
      parts = [subject,
               "shown in place in its own location, at the height "
               + "and position it actually occupies",
               "the surrounding structure visible around it so its "
               + "placement and scale are unambiguous",
               ENVIRONMENT_LIGHT];
      if (reads) parts.splice(1, 0, `bearing the exact legible text "${reads}"`);
    } else if (reads || depicts) {
      parts = [subject];
      if (reads) parts.push(`bearing the exact legible text "${reads}"`);
      if (depicts) {
        parts.push(`the drawings on the page depict ${depicts}, `
          + "rendered as hand-drawn studies of that person "
          + "and no one else");
      }
      parts.push("laid flat, seen straight-on filling the frame, "
        + "every printed element sharp and readable", PROP_LIGHT, PROP_GROUND);
    } else {
      parts = [subject, "the object alone, centered, filling the frame",
               PROP_LIGHT, PROP_GROUND];
    }
  } else if (kind === "environment") {
    const subject = identity || name || "an interior space";
    const move = s.from_ref ? ENVIRONMENT_MOVE[role] : undefined;
    if (move) {
      // The MOVE leads. Behind a paragraph describing a place the model is
      // already looking at, a framing clause loses to the picture.
      parts = [move, subject, ENVIRONMENT_SUBJECT,
               ENVIRONMENT_LIGHT_BY_ROLE[role] ?? ENVIRONMENT_LIGHT];
    } else {
      parts = [subject, ENVIRONMENT_SUBJECT, framing,
               ENVIRONMENT_LIGHT_BY_ROLE[role] ?? ENVIRONMENT_LIGHT];
    }
  } else {
    const move = s.from_ref ? CHARACTER_MOVE[role] : undefined;
    if (move) {
      // The MOVE leads and the identity paragraph goes. Only the NAME
      // survives: a name cannot be mistaken for an instruction to draw a body.
      parts = [move, ...(name ? [name] : []), CHARACTER_LIGHT, CHARACTER_GROUND];
    } else {
      const ident = role === "face" ? faceIdentity(identity) : identity;
      let subject = ident || name || "a person";
      if (name && ident && !new RegExp(`^${escapeRe(name)}\\b`, "i").test(ident)) {
        subject = `${name}, ${ident}`;
      }
      parts = role === "face"
        ? [FACE_MOVE, subject, CHARACTER_LIGHT, CHARACTER_GROUND]
        : [subject, framing, CHARACTER_LIGHT, CHARACTER_GROUND];
    }
  }

  if (note) parts.push(note);
  // World cohesion: era and palette ride every sheet. The face plate is the
  // one exception for palette — a neutral identity anchor must not be tinted
  // by the piece's grade.
  const era = clean(world.era);
  if (era) parts.push(`set in ${era}`);
  const pal = clean(world.palette);
  if (pal && role !== "face") parts.push(`palette of ${pal}`);
  const styleNotes = clean(world.style_notes);
  if (styleNotes && kind !== "character") parts.push(styleNotes);
  // The magic/effects grammar rides only the frames that show effects.
  const vfx = clean(world.vfx_language);
  if (vfx && kind === "scene") parts.push(`all magical effects rendered as ${vfx}`);
  parts.push(styleClause(s.style, kind));

  const head = parts[0].replace(/\.+$/, "");
  let body = parts.slice(1, -1).map((p) => p.replace(/\.+$/, "")).join(", ");
  body = body.slice(0, 1).toUpperCase() + body.slice(1);   // it is a sentence
  // Python's `str.replace` replaces EVERY occurrence — `String.prototype
  // .replace` with a string replaces the first only, and the difference is a
  // stray ".." in exactly the specs whose subject already ends in a period.
  const out = `${head}. ${body}. ${parts[parts.length - 1]}`.replace(/\.\./g, ".");
  if (kind === "environment") {
    return `${out.replace(/\.+$/, "")}. ${ENVIRONMENT_EMPTY}.`;
  }
  return out;
}

/**
 * One reference-sheet prompt, or a refusal.
 *
 * REFUSES rather than falling back, and that is the whole safety property —
 * the same rule `panelPrompt` states. A caller that reaches this with a family
 * it cannot compose for has a routing bug, and a wrong-but-plausible prompt is
 * the one outcome that would hide it.
 */
export function sheetPrompt(spec: SheetSpec, family: string): string {
  if (!(PROSE_FAMILIES as readonly string[]).includes(family)) {
    throw new Error(
      `sheetPrompt cannot compose for "${family}" — only ${PROSE_FAMILIES.join("/")}. `
      + "Every other family composes on the worker (worker/image_prompt.py).");
  }
  const kind = clean(spec?.kind) || "character";
  if (!(SHEET_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `sheetPrompt cannot compose kind "${kind}" — only ${SHEET_KINDS.join("/")}. `
      + "A panel is panelPrompt.ts; a scene_grid composes on the worker.");
  }
  return sheetProse(spec);
}

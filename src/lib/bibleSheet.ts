// The bible entry sheet model — what a kind's sheet is made of, and where
// every key in `doc` belongs.
//
// This is split out of BibleEntryModal because the modal's three defects were
// all data-shape problems wearing a layout costume:
//
//   1. The sheet named fields nothing writes and nothing reads, and did not
//      name the fields the pipeline actually writes. Measured on the live
//      database: PLACE_SHEET asked for `atmosphere`, `layout`, `soundscape`
//      and `continuity` — 0, 1, 0 and 0 rows carry them — while the planner
//      writes `scale`, `features`, `background_life`, `light_sources` and
//      `sound` on 17 environments each, and every one of those was dumped
//      below the form as an unlabelled leftover. So the sheet's own fields
//      rendered as empty boxes directly above the real writing.
//   2. `features`, `materials`, `symbols` and `scenes` are JSON ARRAYS, and
//      the leftover dump required `typeof === "string"` — so a location's
//      named anchor features, the one thing the Continuity Director stages
//      blocking against, were invisible in the UI entirely.
//   3. Everything rendered as a 3-row textarea: an enum (`role`), a colour
//      list (`palette`), and an opaque provider id (`el_voice_id`) alike.
//
// Keeping this pure (no React, no supabase) is what lets the classification
// be tested against the real key distribution rather than eyeballed.

import type { BibleAsset, BibleEntry } from "./db/types";

/* ------------------------------------------------------------------ types */

/** How a value is edited. The renderer is chosen by this, not by guesswork
 *  at the call site — an opaque id and a paragraph are not the same control. */
export type FieldType = "prose" | "enum" | "colors" | "list" | "opaque";

/** Everything a section's dot can say. `partial` is "started, not finished" —
 *  it covers both a half-written section and the downstream case (a voice is
 *  cast but no line has been rendered in it yet). */
export type DotState = "written" | "partial" | "unwritten" | "inherited" | "records";

export interface SheetCtx {
  entry: BibleEntry;
  doc: Record<string, unknown>;
  /** a rendered voice-timbre clip exists for this entry */
  voiceClip: boolean;
  refCount: number;
}

export interface SheetField {
  key: string;
  label: string;
  type: FieldType;
  /** What to write, short enough to be the face of an add-chip. */
  hint: string;
  /** The longer version: the placeholder once the box is open, and the chip's
   *  tooltip. Split from `hint` because a chip that ellipsizes its own
   *  instruction is worse than a short one — and deleting the guidance to fit
   *  is how a field stops saying what makes it usable. */
  guide?: string;
  /** Where the value lives. `entry` is a column, `doc` is the JSON blob. */
  scope?: "entry" | "doc";
  options?: string[];
  /** The value belongs to the world, not to this entry — every entry in the
   *  project carries the same string, so editing it here is a world edit. */
  inherited?: boolean;
  /** Written by the pipeline, shown but never edited. */
  readOnly?: boolean;
  /** No label column — the control spans the writing width. The identity line
   *  and the summary are the section, so a 78px "IDENTITY LINE" beside them
   *  is a caption on a thing that has a heading already. */
  full?: boolean;
  /** Hidden entirely when false — an outfit only means something on a variant. */
  when?: (c: SheetCtx) => boolean;
}

export interface SheetSection {
  id: string;
  label: string;
  /** Rendered mono beside the header: why this section reaches a render. */
  note?: string;
  fields: SheetField[];
  /** Overrides the computed dot with `partial` and says why. */
  attention?: (c: SheetCtx) => string | null;
}

export interface RoleDef {
  id: string;
  label: string;
  hint: string;
  /** Produced ONLY by an `orbit_sheet` take, never by a single `image_gen`.
   *
   *  A location's `coverage` grid is the case: there is no single-image
   *  composer for it — `image_prompt` has no such role, and the reason the
   *  take exists at all is that the image families routinely refuse a
   *  multi-panel layout (the `scene_grids` measurement). So the slot is real
   *  and worth naming on the sheet, and offering it in the "generate this
   *  plate" picker would be a control whose only outcome is one flat image
   *  filed as a grid.
   *
   *  Two consequences, both in `BibleEntryModal`: it is out of the role
   *  picker, and out of `missingRoles` — a plate nothing on this screen can
   *  draw is not something to nag about. */
  takeOnly?: boolean;
}

export interface Sheet {
  roles: RoleDef[];
  anchor: string;
  anchorLabel: string;
  /** What the one-take redraw produces BESIDE the individual views: the
   *  stitched contact sheet, in a bible slot of its own.
   *
   *  It is named here because that slot is otherwise invisible from this
   *  screen. A location's `coverage` is `takeOnly`, so it is not in the
   *  per-role Generate picker and not in the missing-plate chips — correct,
   *  since no single render can draw a grid, and silent, since the only thing
   *  that fills it is a button whose copy did not mention it. */
  takeSheet: string;
  /** What the reference is, in the words the image prompt starts from. */
  subject: (role: string) => string;
  sections: SheetSection[];
  tweakHint: string;
  /** Card title over the reference column, and the word for one of them. */
  refsTitle: string;
  refWord: string;
  /** "Sheet slot" for a person, "Angle" for a place. */
  slotWord: string;
  refCols: number;
  /** A prop has one thumbnail and no Generate card; holding 326px for that is
   *  what leaves half the modal empty. */
  refsWidth: number;
}

/* ----------------------------------------------------------------- sheets */

const IDENTITY_FIELDS: SheetField[] = [
  { key: "identity_line", scope: "entry", label: "Identity line", type: "prose", full: true,
    hint: "6–8 concrete attributes, repeated in every shot",
    guide: "6–8 concrete attributes, repeated verbatim in every shot this entry appears in." },
  { key: "summary", scope: "entry", label: "Summary", type: "prose", full: true,
    hint: "one line for the roll-ups and the planner",
    guide: "One line for the roll-ups, the pickers and the planner." },
];

/** `era` is the world's, not the entry's: 31 of 31 characters, 28 of 28
 *  environments and 31 of 31 props in the live database carry it, and within a
 *  project it is the same string on all of them. It gets its own section on
 *  every kind — the spec draws that section only on a prop, but the reason it
 *  gives ("shared by other entries, so editing it changes the world") is true
 *  of a character too, and the character sheet is exactly where someone edits
 *  the world by accident. */
const WORLD_SECTION: SheetSection = {
  id: "world", label: "World", note: "inherited · shared with the rest of the bible",
  fields: [
    { key: "era", label: "Era", type: "prose", inherited: true,
      hint: "when this is — period and technology",
      guide: "When this is: period, technology level, and what is possible in it." },
  ],
};

export const CHARACTER_SHEET: Sheet = {
  roles: [
    { id: "face", label: "face", hint: "Head and shoulders, neutral — the identity anchor." },
    { id: "full_body", label: "full body", hint: "Standing, front on: proportions and silhouette." },
    { id: "side", label: "side", hint: "Profile, for turns and away-facing shots." },
    { id: "outfit", label: "outfit", hint: "Waist-up with the wardrobe readable." },
    { id: "turnaround", label: "turnaround", hint: "Six views in one grid — rendered together so the angles agree. Stages in place of full body." },
    { id: "master", label: "master", hint: "The catch-all when none of the above fits." },
  ],
  anchor: "face", anchorLabel: "face",
  takeSheet: "a turnaround contact sheet, which a video block then stages as its one picture of the character",
  subject: (r) => `character reference sheet, ${r.replace("_", " ")} view`,
  tweakHint: "changes — e.g. at night, rain-soaked, angrier",
  refsTitle: "Reference sheet", refWord: "reference", slotWord: "Sheet slot",
  refCols: 2, refsWidth: 326,
  sections: [
    { id: "identity", label: "Identity", note: "verbatim in every prompt", fields: IDENTITY_FIELDS },
    { id: "story", label: "Story", note: "reaches the planner", fields: [
      // lead | supporting | extra — storyplan.py validates exactly these three
      // and rewrites anything else to "supporting", so a fourth pill would be
      // a control that silently does nothing.
      { key: "role", label: "Role", type: "enum", options: ["lead", "supporting", "extra"],
        hint: "how much of the piece they carry" },
      { key: "want", label: "Want", type: "prose", hint: "what they want in this piece" },
      { key: "personality", label: "Personality", type: "prose",
        hint: "how they carry themselves",
        guide: "How they carry themselves — this feeds performance direction." },
      { key: "arc", label: "Arc", type: "prose", hint: "where they start and end" },
    ] },
    { id: "look", label: "Look", note: "composes every sheet below the face", fields: [
      { key: "appearance", label: "Appearance", type: "prose",
        hint: "what the camera sees — concrete details",
        guide: "What the camera sees. Concrete and countable beats evocative." },
      { key: "wardrobe", label: "Wardrobe", type: "prose",
        hint: "named garments; the model holds what you name" },
      { key: "outfit", label: "Outfit", type: "prose", hint: "what this variant is wearing",
        when: (c) => Boolean(c.doc.variant_of) },
    ] },
    { id: "voice", label: "Voice", note: "dialogue synthesizes from this",
      // Cast with nothing rendered is the case the amber dot was drawn for:
      // the casting is done and the timbre reference every block stages does
      // not exist yet, which is invisible on every other surface.
      attention: (c) => (c.doc.el_voice_id && !c.voiceClip
        ? "cast, but no line rendered yet" : null),
      fields: [
        { key: "voice", label: "Voice", type: "prose",
          hint: "timbre, pitch and pace",
          guide: "Timbre, pitch and pace — woven into the first vocal event of every block." },
        { key: "speech_pattern", label: "Speech pattern", type: "prose",
          hint: "how they talk — vocabulary, length, one tic",
          guide: "HOW they talk, distinct from everyone else: vocabulary, sentence length, and one tic. The planner checks each character\u0027s lines against this." },
      ] },
    WORLD_SECTION,
  ],
};

export const PLACE_SHEET: Sheet = {
  roles: [
    { id: "master", label: "master", hint: "Wide establishing read — the geography of the space." },
    { id: "alt_angle", label: "alt angle", hint: "The reverse: what the master has its back to." },
    { id: "detail", label: "detail", hint: "Close on surfaces, materials and dressing." },
    { id: "atmosphere", label: "atmosphere", hint: "The space under its own signature light and air." },
    { id: "coverage", label: "coverage", hint: "Every placement in one grid — rendered together so the angles agree. Stages in place of the master.", takeOnly: true },
  ],
  anchor: "master", anchorLabel: "master",
  takeSheet: "a coverage contact sheet carrying every placement, which a video block then stages as its one picture of the place",
  subject: (r) => (r === "master" ? "environment reference" : `environment reference, ${r.replace("_", " ")}`),
  tweakHint: "changes — e.g. at night, after the fire, from the gantry",
  refsTitle: "Plates", refWord: "plate", slotWord: "Angle",
  refCols: 3, refsWidth: 326,
  sections: [
    { id: "identity", label: "Identity", note: "verbatim in every prompt", fields: IDENTITY_FIELDS },
    // Every field below is one the planner writes and the compiler reads.
    // `atmosphere`, `layout`, `soundscape` and `continuity` — the four this
    // sheet used to ask for — are read by nothing in worker/, so they are not
    // offered; an entry that already carries one still shows it under
    // "Also written" rather than losing it.
    { id: "atmosphere", label: "Atmosphere", note: "feeds every beat's light and soundscape", fields: [
      { key: "light_sources", label: "Light sources", type: "prose",
        hint: "the light the place makes for itself",
        guide: "The light the place makes for itself — neon, a skylight, one desk lamp." },
      { key: "sound", label: "Ambience", type: "prose",
        hint: "what the place sounds like before anyone speaks" },
      { key: "background_life", label: "Background life", type: "prose",
        hint: "who and what populates it by default",
        guide: "Who and what populates the space by default. This is what stops it playing as a set." },
    ] },
    { id: "layout", label: "Layout", note: "blocking is staged against these", fields: [
      { key: "scale", label: "Scale", type: "prose",
        hint: "the size of the space in human terms",
        guide: "The size of the space in human terms — footprint, ceiling, distances." },
      { key: "features", label: "Named features", type: "list",
        hint: "2–4 fixtures a shot can anchor to",
        guide: "2–4 named fixtures a shot can anchor to — 'the freight lift', 'the teller cage'." },
    ] },
    { id: "palette", label: "Palette", note: "the location is graded around these", fields: [
      { key: "palette", label: "Palette", type: "colors", full: true,
        hint: "3–5 named colours" },
    ] },
    WORLD_SECTION,
  ],
};

/** Props are not people and not places: they are not rendered from an identity
 *  line at all, so the sheet is writing plus one library reference. */
export const NOTE_SHEET: Sheet = {
  roles: [{ id: "ref", label: "ref", hint: "A reference image for this entry." }],
  anchor: "ref", anchorLabel: "ref",
  // Unreachable, and REQUIRED rather than optional so a new visual sheet
  // cannot forget it: a prop gets no take at all — one flat product shot is
  // not a thing to photograph from eight placements, and `handle_orbit_sheet`
  // refuses the kind outright, which is why the button is gated on `isVisual`.
  takeSheet: "nothing — a prop has no coverage shape",
  subject: () => "prop reference",
  tweakHint: "changes — e.g. cracked, older, at night",
  refsTitle: "Reference", refWord: "reference", slotWord: "Slot",
  refCols: 1, refsWidth: 176,
  sections: [
    { id: "identity", label: "Identity", note: "verbatim in every prompt", fields: IDENTITY_FIELDS },
    { id: "description", label: "Description", note: "renders the prop sheet", fields: [
      { key: "appearance", label: "Description", type: "prose",
        hint: "what it looks like — concrete, countable details" },
      { key: "reads", label: "Reads", type: "prose",
        hint: "the exact visible text, if it is readable",
        guide: "For a READABLE prop — the exact visible text. It is part of the design, and the compiler puts it in the equipment line." },
      { key: "depicts", label: "Depicts", type: "prose",
        hint: "who or what is shown on it, if illustrated",
        guide: "For an ILLUSTRATED prop (a sketchbook, a photo, a poster) — who or what is shown on it." },
    ] },
    { id: "rules", label: "Rules", note: "the director holds to these", fields: [
      { key: "notes", label: "Rules", type: "prose",
        hint: "what it does, what it costs, what it can never do" },
    ] },
    { ...WORLD_SECTION, fields: [
      ...WORLD_SECTION.fields,
      { key: "fixed_to", label: "Fixed to", type: "prose", inherited: true,
        hint: "the location this is mounted in, if it never moves" },
    ] },
  ],
};

export const sheetFor = (kind: string): Sheet =>
  kind === "character" ? CHARACTER_SHEET : kind === "environment" ? PLACE_SHEET : NOTE_SHEET;

/* ------------------------------------------------------------ classifying */

/** Keys that leave the form entirely: provider ids, session stamps, model
 *  names, v1 markers and pipeline bookkeeping. None of it is writing, none of
 *  it is sent to any model as writing, and rendering it as a textarea beside
 *  a character's biography is what made the sheet unreadable. */
export const OPAQUE_KEYS = new Set([
  "sheet_kind", "sheet_read_by", "draft_session", "el_voice_id", "variant_of",
  "from_document", "from_document_title", "v1_kind", "prompt", "singer",
  "scenes", "when", "voice_provider", "openai_voice", "breeze_voice",
]);

/** Keys that hold a rival copy of a value the entry already has a column for.
 *
 *  Measured on the live rows, the two are NOT the same thing and must not get
 *  the same treatment: `sheet_identity` equals `identity_line` in 7 of 7 cases
 *  — it is a record of what the VLM read off the reference sheet — while
 *  `identity_line_written` DIFFERS in 6 of 7, because it is the line a human
 *  or the writer wrote before the sheet was read, and it carries story detail
 *  a picture cannot show. So an identical copy is silent and a differing one
 *  is a decision to put in front of the user. */
export const RIVAL_KEYS: Record<string, "identity_line" | "summary"> = {
  sheet_identity: "identity_line",
  identity_line_written: "identity_line",
  summary: "summary",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isOpaqueKey = (key: string, value: unknown): boolean =>
  OPAQUE_KEYS.has(key)
  || (typeof value === "string" && UUID_RE.test(value.trim()));

/** Empty is empty whatever the shape: "" and [] both mean unwritten, and a
 *  value that is neither a string nor an array is not writing at all. */
export const hasValue = (v: unknown): boolean =>
  Array.isArray(v) ? v.length > 0
    : typeof v === "string" ? v.trim().length > 0
      : false;

export const fieldValue = (f: SheetField, c: SheetCtx): unknown =>
  f.scope === "entry"
    ? (c.entry as unknown as Record<string, unknown>)[f.key]
    : c.doc[f.key];

export const visibleFields = (s: SheetSection, c: SheetCtx): SheetField[] =>
  s.fields.filter((f) => !f.when || f.when(c));

export function sectionState(s: SheetSection, c: SheetCtx): DotState {
  const fields = visibleFields(s, c);
  if (!fields.length) return "unwritten";
  const written = fields.filter((f) => hasValue(fieldValue(f, c)));
  if (fields.every((f) => f.inherited) && written.length) return "inherited";
  if (s.attention?.(c)) return "partial";
  if (!written.length) return "unwritten";
  return written.length === fields.length ? "written" : "partial";
}

export interface RecordChip { key: string; label: string; value: string; multi?: string[] }
export interface Rival { key: string; label: string; value: string; of: "identity_line" | "summary" }
export interface ExtraField { key: string; label: string; type: FieldType; value: unknown }

export interface Classified {
  /** Every doc string the sheet does not name and that is not bookkeeping. It
   *  is still the entry's writing — leaving it out is what buried `palette` on
   *  every location — so it gets a real, labelled field of its own type. */
  extras: ExtraField[];
  records: RecordChip[];
  /** Only the copies that actually DISAGREE with the canonical value. */
  rivals: Rival[];
  written: number;
  total: number;
}

const humanLabel = (k: string) =>
  k.replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase());

const asRecordValue = (v: unknown): { value: string; multi?: string[] } =>
  Array.isArray(v)
    ? { value: v.map(String).join(", "), multi: v.map(String) }
    : { value: typeof v === "string" ? v : JSON.stringify(v) };

export function classifyDoc(sheet: Sheet, c: SheetCtx): Classified {
  const named = new Set<string>();
  let written = 0, total = 0;
  for (const s of sheet.sections) {
    for (const f of visibleFields(s, c)) {
      if (f.scope !== "entry") named.add(f.key);
      if (f.readOnly) continue;
      total += 1;
      if (hasValue(fieldValue(f, c))) written += 1;
    }
  }

  const extras: ExtraField[] = [];
  const records: RecordChip[] = [];
  const rivals: Rival[] = [];

  for (const [key, value] of Object.entries(c.doc)) {
    if (named.has(key)) continue;
    if (value == null || value === "") continue;

    const rivalOf = RIVAL_KEYS[key];
    if (rivalOf) {
      const canonical = ((c.entry as unknown as Record<string, unknown>)[rivalOf] ?? "") as string;
      const text = typeof value === "string" ? value : "";
      // Identical is a record, not a question. Only a copy that says something
      // different is worth a user's attention.
      if (text.trim() && text.trim() !== String(canonical ?? "").trim()) {
        rivals.push({ key, label: humanLabel(key), value: text, of: rivalOf });
      } else {
        records.push({ key, label: humanLabel(key), ...asRecordValue(value) });
      }
      continue;
    }

    if (isOpaqueKey(key, value)) {
      records.push({ key, label: humanLabel(key), ...asRecordValue(value) });
      continue;
    }

    if (Array.isArray(value)) {
      extras.push({ key, label: humanLabel(key), type: "list", value });
    } else if (typeof value === "string") {
      extras.push({ key, label: humanLabel(key), type: "prose", value });
    } else {
      records.push({ key, label: humanLabel(key), ...asRecordValue(value) });
    }
  }

  // Extras are writing too — a director-written note that is not on the sheet
  // still counts toward "is this entry written".
  for (const e of extras) { total += 1; if (hasValue(e.value)) written += 1; }

  return { extras, records, rivals, written, total };
}

/* ------------------------------------------------------------- reference */

/** Roles with an ordinal only where one is needed: a location genuinely holds
 *  two `detail` and two `alt_angle` plates, and six tiles all captioned
 *  "detail" say less than none. The first of a role stays bare. */
export function roleLabels(links: { role: string }[], roles: RoleDef[]): string[] {
  const seen = new Map<string, number>();
  return links.map((l) => {
    const n = (seen.get(l.role) ?? 0) + 1;
    seen.set(l.role, n);
    const base = roles.find((r) => r.id === l.role)?.label ?? l.role.replace(/_/g, " ");
    return n === 1 ? base : `${base} ${n}`;
  });
}

/** Coerce a role to one this sheet — and `bible_assets_role_check` — accepts.
 *
 *  `AssetPickerModal` is shared, and its role vocabulary is the BLOCK's
 *  (`look`, `start_frame`, `chain`, plus `character`/`environment` for anything
 *  it recognises from the bible). None of those is a legal `bible_assets.role`,
 *  so a pick handed straight to `attachRef` fails the check constraint — the
 *  picker seeds each selection from the asset, not from `defaultRole`, so it is
 *  every pick and not an edge case. The table's vocabulary is closed and
 *  enforced in Postgres, so the caller validates rather than trusting a
 *  component whose roles belong to somebody else. */
export const legalRole = (sheet: Sheet, role: string, fallback: string): string =>
  sheet.roles.some((r) => r.id === role) ? role : fallback;

/** Which of an entry's references the anchor slot's pictures actually are:
 *  `live` is the one every generation resolves, `spare` is a second sheet in
 *  the same slot that nothing reads, null is any other role.
 *
 *  Every consumer takes a role with `order=slot&limit=1` (`_resolve_anchor`,
 *  `ref_plan_for`, the pickers), so with two `face` plates on file the
 *  LOWEST-slotted one IS this character's identity and the other is inert —
 *  which is exactly how `regen_sheets.py` retires a sheet without destroying
 *  it. Badging both ANCHOR said the opposite. `links` must be in slot order,
 *  as every read of `bible_assets` in this app is. */
export function anchorStanding(
  link: BibleAsset, sheet: Sheet, links: BibleAsset[],
): "live" | "spare" | null {
  if (link.role !== sheet.anchor) return null;
  const first = links.find((l) => l.role === sheet.anchor);
  return first && first.asset_id === link.asset_id ? "live" : "spare";
}

/** The anchor cannot be detached while it is the ONLY one and other plates
 *  were generated against it — removing it does not un-generate them, it just
 *  leaves the entry with no identity and every future reference free to drift.
 *
 *  A SECOND sheet in the anchor slot lifts the lock from both, because the
 *  thing being protected survives either removal: the entry still has an
 *  identity afterwards. Counting total refs instead of anchor-role ones is
 *  what made a duplicate face plate permanent — both tiles locked, neither
 *  removable, and the wrong one still the identity. */
export const anchorLocked = (link: BibleAsset, sheet: Sheet, links: BibleAsset[]): boolean =>
  link.role === sheet.anchor
  && links.length > 1
  && links.filter((l) => l.role === sheet.anchor).length < 2;

/* --------------------------------------------------------------- palette */

/** `doc.palette` is prose — "humid emerald, cyan, violet, warm gold" — written
 *  by the planner for every location. It is the thing a colourist reads, and
 *  as a sentence in a 2-row textarea it is the least legible field on the
 *  sheet. Naming the colours is only useful if the swatch is right, so an
 *  unrecognised word resolves to null and renders as an empty swatch rather
 *  than as a confident wrong colour. */
export interface Swatch { name: string; hex: string | null }

const BASE: Record<string, string> = {
  // greys and neutrals
  black: "#0d0f14", white: "#f2f4f8", grey: "#8a93a6", gray: "#8a93a6",
  charcoal: "#33383f", slate: "#5b6675", silver: "#c3c9d4", ash: "#9a9ea6",
  gunmetal: "#4a5058", pewter: "#8f949c", bone: "#e6e0d4", ivory: "#f0e9dc",
  cream: "#f2e8d5", sand: "#d8c59c", taupe: "#9b8d7d", concrete: "#a3a49f",
  // reds / oranges / yellows
  red: "#d8443c", crimson: "#b21f38", scarlet: "#d92b1c", maroon: "#6d2029",
  oxblood: "#5c1f22", rust: "#a4522a", brick: "#96453a", copper: "#b06a3b",
  orange: "#e07a2f", amber: "#e8a33d", ochre: "#c08a2e", gold: "#d9a94f",
  brass: "#c39a4e", bronze: "#9c6b3a", yellow: "#e3c94a", saffron: "#e6a72a",
  sodium: "#e8973c", mustard: "#c9a227", honey: "#dda94d", peach: "#eeae8c",
  // greens
  green: "#3f9a5d", emerald: "#2f7d5f", jade: "#2f8f74", moss: "#5c7343",
  olive: "#6f7340", lime: "#8fbf3f", sage: "#93a68a", mint: "#7fd4b0",
  forest: "#2c5c3c", verdigris: "#3f8f80", chartreuse: "#a9c93f",
  // blues / cyans
  blue: "#3f74d8", navy: "#1f2c52", azure: "#3c8fe0", cobalt: "#2b52b8",
  cyan: "#4fc9d6", teal: "#2f8b95", turquoise: "#3fbfb2", aqua: "#5fcfd8",
  indigo: "#41439c", cerulean: "#2f86bd", steel: "#5a7285", ice: "#cfe6f2",
  // purples / pinks
  purple: "#8a6fd4", violet: "#8a6fd4", lavender: "#b7a6e8", lilac: "#c0a8de",
  magenta: "#c4479c", pink: "#e08aa8", rose: "#d9718a", plum: "#6d3f63",
  mauve: "#9a7a94", fuchsia: "#cf4aa8",
  // browns
  brown: "#6f4f37", tan: "#c09a6b", umber: "#5e4634", sepia: "#6b543c",
  chocolate: "#4d3527", walnut: "#5b4032", leather: "#7a5539",
};

/** Modifiers, applied to whichever base word the phrase ends on. */
const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const toRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb: number[]) => `#${rgb.map((v) => clamp(v).toString(16).padStart(2, "0")).join("")}`;
const mix = (hex: string, other: string, t: number) => {
  const a = toRgb(hex), b = toRgb(other);
  return toHex(a.map((v, i) => v + (b[i] - v) * t));
};
const scale = (hex: string, k: number) => toHex(toRgb(hex).map((v) => v * k));
const sat = (hex: string, k: number) => {
  const rgb = toRgb(hex);
  const l = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  return toHex(rgb.map((v) => l + (v - l) * k));
};

const MODS: Record<string, (h: string) => string> = {
  dark: (h) => scale(h, 0.6), deep: (h) => scale(h, 0.62), midnight: (h) => scale(h, 0.45),
  wet: (h) => scale(h, 0.72), shadow: (h) => scale(h, 0.55), burnt: (h) => sat(scale(h, 0.72), 1.1),
  night: (h) => scale(h, 0.5), inky: (h) => scale(h, 0.5),
  pale: (h) => mix(h, "#ffffff", 0.42), light: (h) => mix(h, "#ffffff", 0.34),
  soft: (h) => mix(h, "#ffffff", 0.22), washed: (h) => mix(h, "#ffffff", 0.3),
  bleached: (h) => mix(h, "#ffffff", 0.45), frosted: (h) => mix(h, "#ffffff", 0.38),
  warm: (h) => mix(h, "#ff9a3c", 0.2), cool: (h) => mix(h, "#4c8fff", 0.2),
  cold: (h) => mix(h, "#4c8fff", 0.22), icy: (h) => mix(h, "#9fd6ff", 0.3),
  electric: (h) => sat(h, 1.5), neon: (h) => sat(h, 1.55), vivid: (h) => sat(h, 1.4),
  bright: (h) => sat(mix(h, "#ffffff", 0.12), 1.25), hot: (h) => sat(h, 1.35),
  muted: (h) => sat(h, 0.55), dusty: (h) => sat(h, 0.5), faded: (h) => sat(h, 0.45),
  dull: (h) => sat(h, 0.5), sickly: (h) => sat(mix(h, "#9fbf3f", 0.2), 0.7),
  humid: (h) => sat(h, 0.85), smoky: (h) => sat(scale(h, 0.85), 0.6),
};

/** Split on the separators the writer actually uses. `and` is one of them:
 *  the planner writes "…, blue-violet crystal glow, and orange". */
export const splitPalette = (text: string): string[] =>
  text.split(/[,;/]|\band\b|\n/g)
    .map((s) => s.replace(/^[\s—–-]+|[\s.]+$/g, "").trim())
    .filter(Boolean);

/** English is head-final here: "midnight blue" is a blue, "warm gold" is a
 *  gold. So the LAST recognised base word wins and everything recognised
 *  before it is a modifier. */
export function colorOf(name: string): string | null {
  const words = name.toLowerCase().replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
  let baseAt = -1;
  for (let i = words.length - 1; i >= 0; i--) {
    if (BASE[words[i]]) { baseAt = i; break; }
  }
  if (baseAt < 0) return null;
  let hex = BASE[words[baseAt]];
  for (let i = 0; i < baseAt; i++) {
    const m = MODS[words[i]];
    if (m) hex = m(hex);
  }
  return hex;
}

export const parsePalette = (text: string): Swatch[] =>
  splitPalette(text).slice(0, 8).map((name) => ({ name, hex: colorOf(name) }));

/* ----------------------------------------------------------------- lists */

/** A `list` field round-trips through a comma-separated line, because that is
 *  how someone types four fixtures. Splitting on newlines too means a pasted
 *  bullet list works without reformatting. */
export const parseList = (text: string): string[] =>
  text.split(/[,\n]/g).map((s) => s.replace(/^[\s•*-]+/, "").trim()).filter(Boolean);

export const listText = (v: unknown): string =>
  Array.isArray(v) ? v.map(String).join(", ") : typeof v === "string" ? v : "";

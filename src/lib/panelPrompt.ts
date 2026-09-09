// The panel PROMPT, composed in the browser — twin of the prose branch of
// `worker/image_prompt.py`.
//
// WHY THIS EXISTS. The `hosted` edge function moved the studio's provider keys
// off the pod, so a hosted image render is an HTTPS call this machine can drive on
// `lane: "local"`. It did not move the COMPOSER, and the rule that decides
// which jobs can leave the pod is exactly: a hosted image job runs off-pod iff
// its payload is FINISHED — a literal `prompt` and explicit `ref_asset_ids`.
// A panel carried `prompt_spec` plus late-bound `anchors`, so the whole panel
// path stayed pod-only whatever the model, and on GPT Image 2 the pod's
// contribution was an HTTPS call and a B2 upload: $3.36/hr to run a curl.
// `panelSpec.ts` already builds the spec here; this is the missing half.
//
// ONLY THE PROSE BRANCH IS PORTED, and that is a decision rather than a
// shortcut. The bracketed "stack" contract belongs to the SDXL-family models,
// which are local and need the pod anyway; every family this can render for
// (`openai`, `google`) reads sentences. Porting the stack branch would be 76
// more lines that no caller could reach. A family this cannot compose for is
// REFUSED — see `panelPrompt` — never silently given the wrong dialect, which
// is the exact bug that made hosted panels worth fixing in the first place.
//
// IT IS A TWIN, so it is pinned like one: `scripts/gen_panel_golden.py` emits
// real specs through the Python and commits the strings, and
// `panelPrompt.test.ts` asserts this file reproduces them BYTE FOR BYTE. A
// hand-written parity test would only check the cases someone thought of; the
// failure here is a panel that renders fine and differs from the one the pod
// would have drawn, which nothing else in the app can see.

/** `" ".join(str(v).split())` for a non-blank string, else "". */
export function clean(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim().split(/\s+/).join(" ") : "";
}

/** Python's `_cap`: SDXL attention thins past ~70 words; cut on a clause,
 *  never mid-phrase.
 *
 *  Two details that are easy to lose and both change the output: under the cap
 *  it returns the ORIGINAL text (not the re-joined words), and the trailing
 *  strip takes any run of spaces, commas and semicolons rather than one. */
export function cap(text: string, words: number): string {
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length <= words) return text;
  const kept = parts.slice(0, words).join(" ");
  const cut = Math.max(kept.lastIndexOf(","), kept.lastIndexOf(";"));
  const out = cut > kept.length * 0.6 ? kept.slice(0, cut) : kept;
  return out.replace(/[ ,;]+$/, "");
}

/** Python's `str.capitalize()`: first character up, EVERY OTHER ONE DOWN.
 *  The table below is already lowercase so the difference never shows — which
 *  is exactly why it would survive as a silent divergence if a future entry
 *  carried a capital. */
function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}

// ── the tables, transcribed from image_prompt.py ───────────────────────────

/** Twin of `SHOT_FRAMING`. Grouped by family exactly as the Python is — the
 *  ORDER here is not the match order, see `BY_LEN`. */
const SHOT_FRAMING: ReadonlyArray<readonly [string, string]> = [
  ["extreme close-up", "EXTREME CLOSE-UP: one detail — eyes, hands, or an object — fills the whole frame; nothing else is legible"],
  ["medium close-up", "MEDIUM CLOSE-UP: head and shoulders fill the frame, cut around mid-chest; the background is soft and secondary"],
  ["close-up", "CLOSE-UP: the face fills most of the frame; little of the surroundings is visible"],
  ["extreme wide", "EXTREME WIDE: the location dominates; any figure is small in the frame and the space around them is the subject"],
  ["medium wide", "MEDIUM WIDE: figures from the knees up, with a clear read of the space they stand in"],
  ["establishing", "WIDE ESTABLISHING: the whole location reads at once; figures occupy less than a third of the frame height"],
  ["wide", "WIDE: the whole location reads at once; figures occupy less than a third of the frame height"],
  ["full", "FULL SHOT: figures head to foot, the location visible around them"],
  ["two-shot", "TWO-SHOT: both figures in frame together from the waist up"],
  ["over-the-shoulder", "OVER-THE-SHOULDER: framed past one figure's shoulder onto the other, who faces camera"],
  ["insert", "INSERT: the object alone, filling the frame"],
  ["medium", "MEDIUM SHOT: figures from the waist up"],
];

/** LONGEST KEY WINS, and the list is not written in that order — it is grouped
 *  by family, which puts "close-up" ahead of "over-the-shoulder". Sorted here
 *  for the same reason the Python sorts it rather than hand-ordering: so a new
 *  entry cannot reintroduce the bug where every "over-the-shoulder close-up"
 *  composed as a plain close-up and the reverse was dropped.
 *
 *  Stable, matching Python's `sorted`: equal-length keys keep source order. */
const BY_LEN = [...SHOT_FRAMING].sort((a, b) => b[0].length - a[0].length);

const SHOT_ANGLES: ReadonlyArray<readonly [string, string]> = [
  ["bird", "seen from directly overhead, looking straight down"],
  ["overhead", "seen from directly overhead, looking straight down"],
  ["high angle", "the camera is above the subject, looking down"],
  ["worm", "the camera is at ground level, looking steeply up"],
  ["low-angle", "the camera is below the subject, looking up"],
  ["low angle", "the camera is below the subject, looking up"],
  ["eye level", "the camera is at the subject's eye level"],
  ["eye-level", "the camera is at the subject's eye level"],
];

/** Twin of `PROSE_FRAMING` — the same sizes said as sentences. */
const PROSE_FRAMING: Record<string, string> = {
  "EXTREME WIDE": "a very wide view where the place itself is the subject and any figures are small and distant",
  "WIDE ESTABLISHING": "a wide establishing view of the whole place, with the figures small in the frame",
  "WIDE": "a wide view of the whole place, with the figures small in the frame",
  "FULL SHOT": "a full-length view showing the figures head to foot with the place around them",
  "MEDIUM WIDE": "a medium-wide view of the figures from the knees up, the space clearly readable behind them",
  "TWO-SHOT": "both figures together in frame from the waist up",
  "MEDIUM SHOT": "the figures from the waist up",
  "OVER-THE-SHOULDER": "framed past one figure's shoulder onto the other",
  "MEDIUM CLOSE-UP": "a medium close-up, head and shoulders",
  "CLOSE-UP": "a close-up where the face fills most of the frame",
  "EXTREME CLOSE-UP": "an extreme close-up of a single detail filling the frame",
  "INSERT": "the object alone, filling the frame",
};

const PLATE_MOVE = "Reposition the camera inside this location and shoot a new setup";
const PLATE_MOVE_TAIL =
  "The reference plate establishes what the place is made of, not where this camera stands";

/** Camera prose → [framing, angle]. The planner writes size, angle AND the
 *  official motion grammar; motion is meaningless in a still and dilutes what
 *  is not, so only the first two survive. */
export function shotFraming(camera: unknown): [string, string] {
  const cam = clean(camera).toLowerCase();
  const size = BY_LEN.find(([k]) => cam.includes(k))?.[1] ?? "";
  const angle = SHOT_ANGLES.find(([k]) => cam.includes(k))?.[1] ?? "";
  return [size, angle];
}

// ── the composer ──────────────────────────────────────────────────────────

export interface PanelSpecLike {
  size?: unknown; camera?: unknown; action?: unknown;
  style?: unknown; time_of_day?: unknown; plate?: unknown;
  cast?: Array<{ name?: unknown; identity?: unknown }> | null;
  location?: { name?: unknown; identity?: unknown } | null;
  world?: { palette?: unknown; era?: unknown } | null;
  [k: string]: unknown;
}

/** Twin of `_panel_prose`: a panel for a model that reads sentences.
 *
 *  Written to HiDream-O1's published guidance and shared by GPT Image and
 *  Gemini — coherent descriptive sentences rather than tag fragments, spatial
 *  relationships carried by clauses, the camera stated plainly, style at the
 *  END, 50-75 tokens. */
export function panelProse(spec: PanelSpecLike): string {
  const [size, angle] = shotFraming(spec.size || spec.camera);
  const frame = PROSE_FRAMING[size ? size.split(":")[0] : ""] ?? "";
  const loc = (spec.location && typeof spec.location === "object" ? spec.location : {}) as
    { name?: unknown; identity?: unknown };
  const place = clean(loc.name);
  const placeDesc = clean(loc.identity);
  const names = (spec.cast ?? []).map((c) => clean(c?.name)).filter(Boolean);
  const who = names.slice(0, 3).join(" and ");

  const out: string[] = [];
  // With a location plate staged the framing has to be an INSTRUCTION TO MOVE
  // THE CAMERA rather than a description of a picture. Same words either way;
  // what changes is whether the sentence commands or narrates, and that is the
  // whole difference between a new vantage and a copy of the plate.
  const plate = clean(spec.plate);
  if (plate && frame) {
    out.push(`${PLATE_MOVE}: ${frame}${angle ? `, ${angle}` : ""}. ${PLATE_MOVE_TAIL}.`);
  } else if (plate) {
    out.push(`${PLATE_MOVE}${angle ? `, ${angle}` : ""}. ${PLATE_MOVE_TAIL}.`);
  } else if (frame) {
    out.push(capitalize(frame) + (angle ? `, ${angle}` : "") + ".");
  }
  // The place carries the frame on a wide, so it leads and keeps its
  // distinguishing clause — trimmed, because the cap is the whole point.
  if (place) {
    out.push(`The location is ${place}${placeDesc ? `, ${cap(placeDesc, 22)}` : ""}.`);
  }
  const action = (clean(spec.action) || "the scene continues").replace(/\.+$/, "");
  out.push((who ? `${who}: ` : "") + cap(action, 30) + ".");
  const tod = clean(spec.time_of_day);
  if (tod) out.push(`It is ${tod}.`);
  const style = clean(spec.style) || "cinematic";
  const world = (spec.world && typeof spec.world === "object" ? spec.world : {}) as
    { palette?: unknown };
  const pal = clean(world.palette);
  const art = "aeiou".includes(style.slice(0, 1).toLowerCase()) ? "an" : "a";
  out.push(`In the style of ${art} ${style} storyboard frame`
    + (pal ? `, ${cap(pal, 8)}` : "") + ".");
  return out.join(" ");
}

/** Families this file can compose for — the ones SHAPES marks "prose" AND
 *  that a hosted render can reach. `h3` and `sensenova` are prose too and are
 *  deliberately absent: they are local models, they go to the pod, and `h3`
 *  takes a different branch there (`_h3_panel`) that is not ported. */
export const PROSE_FAMILIES = ["openai", "google"] as const;

/**
 * One panel prompt, or a refusal.
 *
 * REFUSES rather than falling back, and that is the whole safety property. The
 * bug this replaces is a model being handed the wrong dialect in silence —
 * hosted rows took the "stack" default for their entire life because SHAPES
 * had no entry for a catalog id. A caller that reaches this with a family it
 * cannot compose for has a routing bug, and a wrong-but-plausible prompt is
 * the one outcome that would hide it.
 */
export function panelPrompt(spec: PanelSpecLike, family: string): string {
  if (!(PROSE_FAMILIES as readonly string[]).includes(family)) {
    throw new Error(
      `panelPrompt cannot compose for "${family}" — only ${PROSE_FAMILIES.join("/")}. `
      + "Every other family composes on the worker (worker/image_prompt.py).");
  }
  return panelProse(spec);
}

// ── what actually resolved ────────────────────────────────────────────────

/** One staged reference, as `resolveAnchors` reports it back. */
export interface Taken { entry_id: string; role: string | null }
/** A late-bound anchor, as `panelSpec` emits it. */
export interface Anchor { entry_id: string; roles?: string[]; first?: boolean }

/** Twin of `image_prompt.ENVIRONMENT_ROLES`. */
const ENVIRONMENT_ROLES = ["master", "alt_angle", "detail", "atmosphere"];

export interface FinalizeSpec {
  plate?: unknown;
  ref_subjects?: Array<{ name?: unknown; kind?: unknown } | null> | unknown;
  refs?: unknown;
  cast_complete?: unknown;
  [k: string]: unknown;
}

/**
 * The spec as it should be COMPOSED, given what actually resolved.
 *
 * Twin of `handlers/images.finalize_spec`, which was extracted from
 * `handle_image_gen` precisely so an early-composing caller applies the same
 * rules instead of a second reading of them. Pure. Every rule in it was a
 * measured bug:
 *
 *  * **the plate is corrected to what is on file** — `roles` is a preference
 *    order, so the envelope would otherwise describe a plate nobody staged;
 *  * **the subject list is pruned to the anchors that resolved** — the H3
 *    envelope binds `<Subject N>` to `<Picture N>` BY POSITION, and on Rei E4
 *    a discarded draft left a variant anchoring nothing, so "Guide Rei must
 *    match `<Picture 2>`" bound her to the location plate and she rendered as
 *    a clone. `cast_complete` goes with it: with someone unsheeted, "no other
 *    people" contradicts an action still naming them.
 *
 * Only the plate correction currently reaches the prose branch this file's
 * caller composes with — but the whole rule set is mirrored anyway, because
 * "the part that happens not to matter today" is precisely what rots.
 */
export function finalizeSpec<T extends FinalizeSpec>(
  spec: T, planned: Anchor[] | null | undefined, taken: Taken[], hasRefs: boolean,
): T {
  let out: T = spec;
  if (hasRefs) out = { ...out, from_ref: true };
  if (out.plate) {
    const got = taken.find((t) => t.role && ENVIRONMENT_ROLES.includes(t.role))?.role;
    if (got && got !== out.plate) out = { ...out, plate: got };
  }
  const subjects = out.ref_subjects;
  if (Array.isArray(planned) && Array.isArray(subjects) && subjects.length === planned.length) {
    const resolved = new Set(taken.map((t) => t.entry_id));
    const keep = planned.map((a, i) => [a, i] as const)
      .filter(([a]) => a && resolved.has(a.entry_id)).map(([, i]) => i);
    if (keep.length !== planned.length) {
      const refs = out.refs;
      out = {
        ...out,
        ref_subjects: keep.map((i) => subjects[i]),
        ...(Array.isArray(refs) && refs.length === planned.length
          ? { refs: keep.map((i) => refs[i]) } : {}),
      };
      delete (out as Record<string, unknown>).cast_complete;
    }
  }
  return out;
}

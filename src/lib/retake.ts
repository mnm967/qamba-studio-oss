// The two intents behind "render this block again", and every decision that
// differs between them.
//
// Split out of PromptRefsModal for the reason panelSpec.ts is split out of
// panels.ts: the component reaches supabase, so none of this could be tested —
// and every decision here fails SILENTLY when it is wrong.
//
//  * An Edit queued against a model that declares no video reference renders a
//    plain regenerate wearing an edit's label: the anchor is simply not passed
//    and nothing says so.
//  * An anchor pointing at a deleted or rejected take queues a job whose first
//    act is `source asset not found`.
//  * A seed HELD where it should roll returns near-identical footage, which
//    reads as the button not having worked.
//  * Voice references counted against the picture ceiling showed "10 / 9" on a
//    block staging 8 pictures and 2 voice refs, and refused a ninth picture
//    there was room for.
//
// Nothing here imports anything that touches the network — `director/refs.js`
// is pure label arithmetic and qualifies.
import { blockRef } from "../../director/refs.js";

export type RetakeMode = "regenerate" | "edit";

/** The capability keys this decision reads, straight off `model_catalog`.
 *
 *  `refVideos` is the one that decides whether Edit exists at all: the anchor
 *  rides in as a VIDEO reference (H3's `<Video 1>`), which is a separate budget
 *  from the nine pictures — official §2.5, the same independent-counting rule
 *  the voice slots follow. LTX 2.5's MSR guide takes images only, so Edit is
 *  genuinely unavailable there rather than quietly degraded. */
export interface RetakeCaps {
  multiRef?: number;
  refVideos?: number;
  refAudios?: number;
  audio?: boolean;
}

export interface TakeRef {
  id: string;
  asset_id: string;
  state?: string | null;
}

/** A take you can anchor an edit on: it has media, and it wasn't thrown out. */
export const isUsableAnchor = (t: TakeRef): boolean =>
  !!t.asset_id && t.state !== "rejected";

/** Why Edit can't run here, or "" when it can. Phrased for the tab's `title`
 *  and for the footer strip — both are read by someone wondering why the
 *  button is grey.
 *
 *  Two checks, not one, and both are load-bearing: `caps.refVideos` is the
 *  BUDGET (how many video slots the model has at all), and `modes` is what
 *  the worker will actually let it render. `handle_video_edit` renders on a
 *  hardcoded `"r2v"` — it does not read `block.mode` and has no v2v path — so
 *  a model that declares `refVideos` without listing `r2v` among its modes
 *  would pass the budget check, queue clean, and die server-side on
 *  `mode 'r2v' not available for <model>`. Checking `modes` here is what
 *  turns that into a disabled tab instead of a failed job. */
export function editBlocker(
  takes: TakeRef[], caps: RetakeCaps, modelName: string, modes: string[] = [],
): string {
  if (!takes.some(isUsableAnchor)) {
    return "Nothing rendered yet — the first take has to exist before you can edit it.";
  }
  if (!caps.refVideos || !modes.includes("r2v")) {
    return `${modelName} doesn't render r2v with a video reference, so it can't hold a take `
      + `as the anchor — pick a model that does (MiniMax H3), or regenerate.`;
  }
  return "";
}

/** Opening intent. A block with a take is usually opened to change what is in
 *  it; a block with nothing rendered has nothing to hold. */
export const defaultMode = (
  takes: TakeRef[], caps: RetakeCaps, modelName: string, modes: string[] = [],
): RetakeMode => (editBlocker(takes, caps, modelName, modes) ? "regenerate" : "edit");

/** The anchor, resolved against what still exists.
 *
 *  Spec §4: if the anchored take is later rejected or deleted the card falls
 *  back to the active take and says so. `fellBack` is what the footer strip
 *  reports — silently re-pointing an edit at different footage is worse than
 *  the render failing, because the result looks deliberate. */
export function resolveAnchor(
  takes: TakeRef[], anchorId: string | null, activeId: string | null,
): { take: TakeRef | null; index: number; fellBack: boolean } {
  const usable = takes.filter(isUsableAnchor);
  const at = (id: string | null) => (id ? usable.find((t) => t.id === id) ?? null : null);
  const asked = at(anchorId);
  const take = asked ?? at(activeId) ?? usable[usable.length - 1] ?? null;
  return {
    take,
    // 1-based over ALL takes, so the number matches the takes strip and the
    // "take 3" the user is looking at — not the position in the usable subset.
    index: take ? takes.findIndex((t) => t.id === take.id) + 1 : 0,
    fellBack: !!anchorId && !asked && !!take,
  };
}

export interface ModeCopy {
  tab: string;
  /** live state, not static copy — takes the resolved anchor's number */
  tabSub: (anchorNo: number, selected: boolean) => string;
  briefLabel: string;
  placeholder: string;
  refsLabel: string;
  chips: string[];
  primary: (nextTake: number) => string;
}

export const COPY: Record<RetakeMode, ModeCopy> = {
  regenerate: {
    tab: "Regenerate",
    tabSub: () => "new roll · same references",
    briefLabel: "What should be different this time",
    placeholder:
      "Plain notes. “Push in slower, hold two beats at the gate before she looks up.” "
      + "The director rewrites this block's shots around it, reading the references "
      + "below — and can merge shots into one when you ask for fewer cuts.",
    refsLabel: "References",
    chips: ["one continuous shot, no cuts", "hold 2s before cut",
            "practical light only", "slow push", "static camera",
            "closer on her face"],
    primary: (n) => `Regenerate as take ${n}`,
  },
  edit: {
    tab: "Edit a take",
    tabSub: (n, selected) =>
      n ? `${selected ? "holding" : "hold"} take ${n} · change one thing`
        : "change one thing",
    briefLabel: "What should this edit change",
    placeholder:
      "Name the one thing that changes. “Put the glass orb from the new reference in her "
      + "hands as she stops at the gate.” Everything you don't name is held from the anchor.",
    refsLabel: "References for the edit",
    chips: ["change the light", "slow the walk", "fix the hands",
            "swap wardrobe", "extend the hold"],
    primary: (n) => `Edit into take ${n}`,
  },
};

/** Seed. Regenerate rolls — a regenerate that reuses the seed returns
 *  near-identical footage, which reads as the button not working. An edit
 *  holds the block's, because the whole promise is that only the named thing
 *  moves. Either is overridable; the DEFAULT is what follows the intent. */
export type SeedMode = "roll" | "hold";
export const defaultSeedMode = (m: RetakeMode): SeedMode => (m === "edit" ? "hold" : "roll");
export const rollSeed = (rnd: () => number = Math.random): number =>
  Math.floor(rnd() * 9000) + 1000;

/** `ref_plan` holds pictures AND audio, and the two number independently
 *  (official §2.5). Everything in this modal that counts, caps or renders a
 *  grid means PICTURES; the voice entries round-trip untouched and are
 *  re-appended on every write, because filtering without re-appending silently
 *  strips a block's voice references. */
export function splitRefs<T extends { purpose?: string | null }>(
  plan: T[],
): { pictures: T[]; voices: T[] } {
  return {
    pictures: plan.filter((r) => r.purpose !== "voice"),
    voices: plan.filter((r) => r.purpose === "voice"),
  };
}

export interface SummaryInput {
  mode: RetakeMode;
  anchorNo: number;
  refCount: number;
  seedMode: SeedMode;
  seed: number | null;
  width: number;
  height: number;
}

/** The footer's mono strip, minus the cost (which the component styles amber).
 *  Regenerate: `3 refs · new seed · 1280×736`
 *  Edit:       `anchor take 1 · 3 refs · seed locked` */
export function footerSummary(o: SummaryInput): string {
  const parts: string[] = [];
  if (o.mode === "edit" && o.anchorNo) parts.push(`anchor take ${o.anchorNo}`);
  parts.push(`${o.refCount} ref${o.refCount === 1 ? "" : "s"}`);
  parts.push(o.seedMode === "roll" ? "new seed"
    : o.seed != null ? `seed ${o.seed} locked` : "seed locked");
  parts.push(`${o.width}×${o.height}`);
  return parts.join(" · ");
}

/** The `Picture N` labels a brief names that no staged reference will carry —
 *  the twin of `h3_prompt.dangling_picture_refs`, whose docstring carries the
 *  measurement. `compile_video_edit` defines `<Picture 1>`..`<Picture N>` for
 *  the pictures actually staged, and naming one is what binds the change to
 *  it; a name with no picture behind it is an instruction pointing at nothing,
 *  and the render comes back unchanged with nothing saying why.
 *
 *  This is the easy mistake to make on the Edit tab specifically, because that
 *  grid starts EMPTY and never inherits the block's staged set: the block can
 *  be staging eight pictures while the edit stages none.
 *
 *  Only the word the envelope itself emits, and only with a number. "the
 *  picture she is holding" is prose about the shot, and a false positive here
 *  refuses an edit that would have worked. */
export function danglingPictureRefs(instruction: string, refCount: number): number[] {
  // Built per call rather than hoisted: a /g regex carries `lastIndex`, and a
  // shared one is a stateful module global for the sake of one allocation.
  const label = /<?\s*\bpictures?\s*#?\s*(\d+)\s*>?/gi;
  const have = Math.max(0, Math.trunc(refCount) || 0);
  const want = new Set<number>();
  for (const m of (instruction || "").matchAll(label)) want.add(Number(m[1]));
  return [...want].filter((n) => n < 1 || n > have).sort((a, b) => a - b);
}

/** Does this brief ask for something to be TAKEN AWAY without saying what is
 *  there instead?
 *
 *  The failure it warns about is the most repeated measurement in this
 *  codebase and the easiest to walk into, because subtraction is the natural
 *  way to ask: these models ADD what they are told and cannot remove, so
 *  "remove the helmet from the floor" puts the helmet into the description the
 *  render reads, and it draws it. The brief is passed VERBATIM into
 *  `compile_video_edit`, so nothing downstream repairs it — the take comes
 *  back with the helmet still there and nothing anywhere says why.
 *
 *  A HINT, never a blocker. It is a judgement about writing rather than a
 *  precondition, `editSystem` will convert it the moment Sharpen is pressed,
 *  and a phrasing this cannot parse is still a perfectly good edit. So it is
 *  tuned to fire slightly too often rather than to miss: an unnecessary line
 *  of advice costs nothing, and a silent wrong render costs a render.
 *
 *  Silent when the brief ALSO names what takes the place — "replace the helmet
 *  with bare floor" is already the correct shape and does not want advice. */
export function readsAsRemoval(brief: string): boolean {
  const t = ` ${(brief || "").toLowerCase().replace(/[’']/g, "'")} `;
  // Already phrased as a substitution: whatever else it says, the writer has
  // named the thing that occupies the space.
  if (/\b(replace[sd]?|instead of|in place of|swap(?:ped|s)?)\b/.test(t)) return false;
  return [
    /\b(remove|delete|erase|hide|lose|drop)\b/,
    /\bget rid of\b/,
    /\btake\s+(?:it|them|that|the\s+\w+)\s+(?:out|off|away)\b/,
    /\bshould\s*n(?:o|')t\b/,
    /\bwith\s*out\b/,
    /\bnot\s+be\s+(?:wearing|holding|carrying|visible|present|there|in)\b/,
    /\bno\s+(?:more\s+)?(?:one|other|second|extra|\w+s)\b/,
    // People write "only person in the room" as often as "only ONE person":
    // the count word is the one they drop, and a naive pattern needs it.
    /\bonly\s+(?:one\s+|1\s+|a\s+single\s+)?(?:person|people|character|figure|subject)\b/,
  ].some((re) => re.test(t));
}

/** Why the queue button is refusing, or "" when it will queue.
 *  Checked here rather than in the worker for the reason `modeBlocker` is: a
 *  job that dies on its preconditions still costs a claim and reads in the
 *  queue as a mysterious failure. */
export function queueBlocker(o: {
  mode: RetakeMode;
  brief: string;
  anchor: TakeRef | null;
  editWhy: string;
  /** How many pictures THIS EDIT stages — the edit's own grid, never the
   *  block's plan. Required rather than optional: the check it feeds is the
   *  one a new caller would not think to add, and defaulting it to 0 would
   *  refuse every correct edit made from a surface that forgot to pass it. */
  refs: number;
}): string {
  if (o.mode !== "edit") return "";
  if (o.editWhy) return o.editWhy;
  if (!o.anchor) return "No take to anchor this edit on.";
  if (!o.brief.trim()) {
    return "Say what the edit changes — an edit with no instruction re-renders the take as it is.";
  }
  const dangling = danglingPictureRefs(o.brief, o.refs);
  if (dangling.length) {
    const named = dangling.map((n) => `Picture ${n}`).join(", ");
    return `The brief names ${named}, and this edit stages ${o.refs} `
      + `picture${o.refs === 1 ? "" : "s"}. Add it below — the edit's references start `
      + `empty, they don't carry over from the block — or drop the label.`;
  }
  return "";
}

/** What an Edit hands the worker. `video_edit` already exists and does exactly
 *  this — the source becomes H3's `<Video 1>` with "preserve its framing,
 *  timing and subjects except where the instruction changes them", which IS
 *  the "hold everything you didn't name" the copy promises — so Edit reuses it
 *  rather than inventing an `intent: "edit"` flag no handler reads.
 *
 *  `model_key` matters: the handler defaulted to plain H3 whatever the picker
 *  said, so an edit on the Turbo row rendered on the 20-step checkpoint with
 *  nothing on screen to say so. Hosted rows deliberately carry no key — they
 *  have no model_map entry, and one the worker cannot resolve fails the render
 *  (the same rule the wizard's `*-local` gate follows). */
// Extends the index-signature type so it can be handed straight to
// `enqueueJob`'s `Record<string, unknown>` payload without a cast that would
// also swallow a genuine mistake.
export interface EditPayload extends Record<string, unknown> {
  source_asset_id: string;
  prompt: string;
  ref_asset_ids: string[];
  seed: number;
  model_key?: string;
  loras?: unknown;
  width?: number;
  height?: number;
  activate: "review" | "replace";
  user_edit: true;
  label: string;
}

export function editPayload(o: {
  anchor: TakeRef;
  anchorNo: number;
  blockIdx: number;
  brief: string;
  refAssetIds: string[];
  seed: number;
  modelKey?: string | null;
  loras?: unknown;
  width?: number;
  height?: number;
  /** Where the take LANDS, when the caller has asked. Defaults to `review`
   *  and PromptRefsModal leaves it there: an edit is a proposal until someone
   *  has looked at it, and that modal offers no other choice. The clip-born
   *  retake DOES offer one — "land beside the other takes" / "replace on the
   *  lane" is the first thing on that screen — so it passes what was chosen
   *  rather than having the control silently mean nothing. */
  activate?: "review" | "replace";
}): EditPayload {
  return {
    source_asset_id: o.anchor.asset_id,
    prompt: o.brief.trim(),
    ref_asset_ids: o.refAssetIds,
    seed: o.seed,
    ...(o.modelKey ? { model_key: o.modelKey } : {}),
    ...(o.loras ? { loras: o.loras } : {}),
    ...(o.width && o.height ? { width: o.width, height: o.height } : {}),
    // Side by side unless the caller was given the choice and the user made
    // it. Never SILENTLY canonical, which is what the default protects.
    activate: o.activate ?? "review",
    user_edit: true,
    label: `${blockRef(o.blockIdx)} edit of take ${o.anchorNo}`,
  };
}

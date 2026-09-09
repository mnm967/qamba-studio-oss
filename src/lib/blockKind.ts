// What KIND of block this is, and therefore what to call it and how to draw it.
//
// `generation_blocks` began as one thing — a shot the planner wrote — and now
// holds four: planner shots, timeline TRIMS (block_from_clip from a source
// block), and the two the timeline's generate actions make, CHAINS (a bridge
// between two shots, flf) and EXTENSIONS (more of one shot, i2v). They are
// not interchangeable anywhere it matters:
//
//   * a chain is not "Block 9". It is the join between 8 and 9, and calling it
//     a block loses the one fact that explains why it is 3.7s long and sits
//     between two shots. The user wrote "Chain: …" on it and the label was
//     overwritten with a number.
//   * a chain/extension has NO BEATS — it renders from a stored recipe — so
//     the beats-path retake modal has nothing true to say about it.
//   * on the lane it should not look like the shots it joins.
//
// THE RULE ITSELF LIVES IN `director/block_kind.js`, plain JS, because the
// director's toolset needs it too and that file is loaded by the serverless
// functions and by `node --test`, neither of which can import a `.ts` module.
// This file is the typed surface over it — five surfaces ask (the lane, the
// takes strip, the retake router, the shot sidebar, the director's block
// index) and a rule answered differently in one of them is how "Block 9" got
// written over "Chain: …" and how an extension read as "Block 19".
import type { GenerationBlock } from "./db/types";
import {
  blockKindOf, isClipBornBlock, kindFromMode as kindFromModeJs, kindLabel,
  labelIsAuto as labelIsAutoJs, RENDERING_SUFFIX,
} from "../../director/block_kind.js";

export type BlockKind =
  /** flf bridge between two shots — the timeline's "chain with next". */
  | "chain"
  /** i2v continuation of one shot — the timeline's "extend". */
  | "extend"
  /** a free-standing generated shot (t2v "add block after"), or a promoted
   *  clip whose recipe never said which of the three it was. */
  | "shot"
  /** a window of another block's take, saved as a block of its own. */
  | "trim"
  /** what the planner wrote. */
  | "plan";

/** Render mode → kind. The mode IS the action: the chain modal sends flf and
 *  the extend modal i2v (MODE_FOR in BlockActionModal). */
export function kindFromMode(mode: string | null | undefined): BlockKind {
  return kindFromModeJs(mode) as BlockKind;
}

/**
 * This block's kind, from its params alone.
 *
 * Order matters: `clip_kind` is STAMPED at creation and is authoritative;
 * the recipe's mode is the fallback for blocks made before the stamp; and a
 * `derived_from` naming a CLIP is a promotion whose recipe was never
 * recovered — clip-born, kind unknown, so the generic "shot". A
 * `derived_from` naming a BLOCK is a trim, which keeps its beats and its
 * ordinary retake path.
 */
export function blockKind(block: Pick<GenerationBlock, "params"> | null | undefined): BlockKind {
  return blockKindOf(block as { params?: unknown } | null | undefined) as BlockKind;
}

/** Does this block render from a recipe rather than from storyboard beats? */
export function isClipBorn(block: Pick<GenerationBlock, "params"> | null | undefined): boolean {
  return isClipBornBlock(block as { params?: unknown } | null | undefined);
}

/** What to call this block — "Chain 9", "Extension 4", "Block 7".
 *  1-indexed, like every other block reference (director/refs.js). */
export function blockLabel(kind: BlockKind, idx: number): string {
  return kindLabel(kind, idx);
}

/**
 * Is this label one the studio WROTE, or one a person did?
 *
 * The lane's label is a stored column, so a renumber has to rewrite it — and
 * rewriting one somebody typed ("Chain: How the reference pictures align") is
 * exactly the loss being fixed here. Only the auto forms are rewritten:
 * "<noun> <n>", optionally with the detached-audio or the rendering suffix.
 *
 * A null/blank label counts as auto — there is nothing to preserve.
 */
export function labelIsAuto(label: string | null | undefined): boolean {
  return labelIsAutoJs(label);
}

/** The label a clip of this block should carry, KEEPING anything a person
 *  wrote. `audio` appends the detached-half suffix the worker uses;
 *  `rendering` marks a placeholder whose first render is still in flight. */
export function clipLabelFor(
  kind: BlockKind, idx: number, current?: string | null,
  o: { audio?: boolean; rendering?: boolean } = {},
): string {
  if (!labelIsAuto(current)) return current as string;
  return blockLabel(kind, idx) + (o.audio ? " · audio" : o.rendering ? RENDERING_SUFFIX : "");
}

/** The lane's modifier class — `.ws-clip.k-chain` etc. Only the two kinds
 *  that are visually distinct on the timeline get one; a trim IS a shot of
 *  the plan and should not read as something else. */
export function clipKindClass(kind: BlockKind): string {
  return kind === "chain" || kind === "extend" ? ` k-${kind}` : "";
}

export { RENDERING_SUFFIX };

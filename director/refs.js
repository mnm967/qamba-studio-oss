/**
 * How a scene, a shot and a block are NAMED — one convention, one module.
 *
 * These labels are the address space the user and the director share: someone
 * reads "b7" off the storyboard and types "redo b7", and every tool has to
 * resolve that to the same row. Until this module existed the three kinds
 * disagreed with each other:
 *
 *   scenes  S3  -> idx 2   (1-indexed)
 *   shots   b4  -> idx 3   (1-indexed)
 *   BLOCKS  b4  -> idx 4   (0-INDEXED)
 *
 * so `b6` meant the SEVENTH block but the SIXTH shot, on the same screen, in
 * the same sentence. Measured consequence: asked to "redo block 6 and seven"
 * on a seven-block storyboard, the director looked at b5 and b6, re-rendered
 * one of them, and reported success — because a storyboard of seven blocks
 * labelled b0..b6 has no b7, and nothing said so.
 *
 * ONE-INDEXED WINS, for three reasons: scenes and shots already were, so it is
 * the smaller change; people count from one, and the label exists for people;
 * and a screenplay's scenes have always been numbered from one.
 *
 * `idx` in the database is untouched and stays 0-based. This is a display and
 * addressing concern only — never store a ref.
 */

/** Every ref kind counts from here. Changing it changes every surface at once. */
export const REF_BASE = 1;

export const blockRef = (idx) => `b${Number(idx) + REF_BASE}`;
export const sceneRef = (idx) => `S${Number(idx) + REF_BASE}`;
/** A shot inside a scene. Same letter as a block on purpose — they are told
 *  apart by which argument they are passed to, never by their spelling. */
export const shotRef = (idx) => `b${Number(idx) + REF_BASE}`;

/**
 * "b7" / "B7" / "7" -> the 0-based idx, or null when it is not a ref at all.
 *
 * Returns null rather than NaN so a caller can tell "not a ref" (try a slug,
 * try a uuid) from "ref that resolved to nothing" — those want different
 * errors, and conflating them is how a bad ref used to come back as a raw
 * Postgres 22P02.
 */
export function refToIdx(ref, letter = "b") {
  const m = String(ref ?? "").trim().match(
    new RegExp(`^${letter}?(\\d+)$`, "i"));
  if (!m) return null;
  const idx = Number(m[1]) - REF_BASE;
  return idx >= 0 ? idx : null;
}

export const blockRefToIdx = (ref) => refToIdx(ref, "b");
export const sceneRefToIdx = (ref) => refToIdx(ref, "s");
export const shotRefToIdx = (ref) => refToIdx(ref, "b");

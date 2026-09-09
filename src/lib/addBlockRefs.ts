// REFERENCES ON "ADD BLOCK AFTER" — the pure half.
//
// A new block made from the lane was text-to-video and nothing else: no way to
// hold a character's face, the location, or a storyboard panel. So the one
// thing every block of an episode is built on was the one thing the timeline's
// own "add a block" could not do, and the only route to it was planning the
// shot into the storyboard first.
//
// WHY ATTACHING A PICTURE CHANGES THE MODE, rather than being a field on the
// one it already had. H3's reference set and its keyframes live on DIFFERENT
// CHECKPOINTS — fl2va serves t2v/i2v/flf, ref2va serves r2v — and
// `handle_clip_gen` follows that: it wires `ref_images` under `if mode ==
// "r2v"` and nowhere else. So references are not an addition to a text shot,
// they ARE a different mode of it, and a model with no r2v cannot take one.
//
// WHY EXTEND AND CHAIN ARE NOT OFFERED THE SAME THING. Same sentence read the
// other way: an extend is i2v and a chain is flf, both fl2va, both with no
// reference input on the pod path — whatever model is picked, since the
// handler's wiring is per MODE and not per model. `ref_asset_ids` sent there
// would be staged into ComfyUI's input directory and then silently dropped,
// which is the shape of failure this studio keeps paying for. (One hosted API
// really does take both at once — Wan 3.0 declares `first_frame`, `last_frame`
// and `reference_image` on a single endpoint — but that row ships disabled and
// has never been run against a live key, so nothing offers it yet.)
import type { ModelCatalogRow } from "./db/types";

export type BlockAction = "add_after" | "extend" | "chain";

type Caps = { multiRef?: number; backgroundRef?: boolean };
const capsOf = (m: ModelCatalogRow | null | undefined) => (m?.capabilities ?? {}) as Caps;

/**
 * The mode the model PICKER filters on — the action's floor, not its current
 * shape.
 *
 * Deliberately blind to the references: filtering on the effective mode would
 * drop the selected model out from under the picker the moment a reference was
 * attached and silently re-pick another, which is the substitution this modal
 * already refuses to make elsewhere. A model that cannot serve r2v stays
 * offered — it can still render the text block — and the reference control is
 * what says why it cannot take a picture.
 */
export function baseModeFor(action: BlockAction): string {
  return action === "extend" ? "i2v" : action === "chain" ? "flf" : "t2v";
}

/** The mode the JOB asks for, once the references are counted. */
export function jobModeFor(action: BlockAction, refCount: number): string {
  return action === "add_after" && refCount > 0 ? "r2v" : baseModeFor(action);
}

/**
 * Why references cannot be attached here, or null when they can.
 *
 * A REASON rather than a boolean, and shown rather than hidden: "you cannot"
 * and "you cannot, because this model renders from text alone" are different
 * amounts of help, and the second one names the fix (pick another model).
 */
export function refsBlocker(
  action: BlockAction,
  model: ModelCatalogRow | null | undefined,
): string | null {
  if (action === "extend") {
    return "An extension opens on the last frame — that frame is its reference, "
      + "and the reference set is a different checkpoint.";
  }
  if (action === "chain") {
    return "A chain runs between two frames — those are its references, and the "
      + "reference set is a different checkpoint.";
  }
  if (!model) return "Pick a model first.";
  if (!(model.modes ?? []).includes("r2v")) {
    return `${model.display_name} has no reference mode — it renders from text alone.`;
  }
  return null;
}

/** How many pictures this model takes. Ref2VA's 9 is H3's; LTX 2.5 takes 4. */
export function refCapOf(model: ModelCatalogRow | null | undefined): number {
  return Number(capsOf(model).multiRef ?? 9) || 9;
}

/**
 * Does this model have a dedicated BACKGROUND slot? (LTX 2.5's MSR guide.)
 *
 * Nothing offers it from this screen yet — stated here so the question has one
 * answer when it does, rather than being re-derived from a family name.
 */
export function hasBackgroundSlot(model: ModelCatalogRow | null | undefined): boolean {
  return !!capsOf(model).backgroundRef;
}

/**
 * Why the SUBMIT cannot go, or null.
 *
 * Asked again at the click because a selection outlives the thing that made it
 * legal: attach references to a model that does r2v, switch to one that does
 * not, and the payload would ask a text-only model for a reference render. The
 * job would fail on the pod with `mode 'r2v' not available`, minutes later.
 */
export function submitBlocker(
  action: BlockAction,
  model: ModelCatalogRow | null | undefined,
  refCount: number,
): string | null {
  if (!refCount) return null;
  const why = refsBlocker(action, model);
  return why && `${why} Remove the references, or pick a model that can hold them.`;
}

// The sheets bar at the top of the wizard's cast & world step.
//
// WHAT IT REPLACED, because the shape is the point: a paragraph at the very
// BOTTOM of that step, under three grids of cards. On a real episode that is
// twelve names run together into five lines of prose, below the fold, about
// the one decision on the screen that is cheap now and expensive once the
// blocks have rendered. The count leads, the names are chips that open their
// entry, and it sits above the Cast grid.
//
// THE MODEL RIDES IN IT because the model is what the button spends. Every
// enqueue on that step — this bulk action and the per-card re-roll alike —
// reads the wizard's `imageModel`, and the only picker for it was on step 1,
// two screens back. Every face, plate and prop of the episode is drawn by that
// pick and each is then the anchor for everything after it, so leaving it
// invisible here is the most consequential silent default in the wizard.
//
// It stays when nothing is missing rather than vanishing with the warning: the
// per-card re-roll buttons spend the same pick, and a control that disappears
// while it can still be used is worse than one that is merely quiet.
//
// It takes what it RENDERS rather than the wizard's world, for the reason
// `TakeRow` takes its evidence rather than the whole assembly context: the
// three states it has to be looked at in — something missing, something
// drawing, nothing to do — are minutes apart on the real screen and are all a
// prop away here. See /ui/castworld.
import React from "react";
import { AlertTriangle, Check, ImagePlus, Loader2, RefreshCw } from "lucide-react";
import ImageModelPicker from "../ui/ImageModelPicker";
import type { ModelCatalogRow } from "../../lib/db/types";

/** How many of the missing names are shown before the rest are counted.
 *  Twelve chips is the wall this replaces wearing a different shape. */
export const REF_CHIPS = 6;

export type RefEntry = { id: string; name: string; kind: string };

/** "4 characters, 9 locations and 3 props have", "1 prop has".
 *
 *  The count leads because it is the thing being decided; the KINDS are named
 *  because they miss differently — a character with no face plate is a
 *  different face in every block, a location with no plate is a room invented
 *  fresh in every block that visits it, a prop with no sheet is an object that
 *  degrades mid-shot. Rolling them into "12 entries" hides which you are
 *  looking at.
 *
 *  CHARACTERS ARE IN THIS LIST NOW. They were left out on the reasoning that a
 *  face plate is the identity anchor everything else derives from, so the plan
 *  queues it rather than offering it as a catch-up — true for as long as the
 *  plan always did. It is a choice now (see `planAuto.ts`), and a bar that
 *  silently omitted the one kind nothing had drawn would report a bible with
 *  no faces in it as complete. */
export const refLabel = (list: RefEntry[]) => {
  const n = (k: string) => list.filter((e) => e.kind === k).length;
  const part = (c: number, one: string) => `${c} ${one}${c === 1 ? "" : "s"}`;
  const parts = ([["character", "character"], ["environment", "location"],
                  ["prop", "prop"]] as const)
    .map(([k, one]) => (n(k) ? part(n(k), one) : ""))
    .filter(Boolean);
  const last = parts.pop() ?? "";
  const nouns = parts.length ? `${parts.join(", ")} and ${last}` : last;
  return `${nouns} ${list.length === 1 ? "has" : "have"}`;
};

export default function CastWorldRefsBar({
  pending, drawing, models, model, onModel, queuing, onGenerate, onOpen,
  redrawable = 0, onRedrawAll,
}: {
  /** Missing a sheet and with nothing queued — what the button would draw. */
  pending: RefEntry[];
  /** Missing a sheet with a job already in flight. Counted, never re-queued. */
  drawing: number;
  models: ModelCatalogRow[];
  model: string | null;
  onModel: (id: string) => void;
  queuing: boolean;
  onGenerate: () => void;
  onOpen: (entryId: string) => void;
  /** How many entries "redraw everything" would clear and draw again — every
   *  character, location and prop that is not already mid-draw, drawn or not.
   *  Zero hides the button rather than disabling it: an empty bible has
   *  nothing to redraw and the offer would be noise. */
  redrawable?: number;
  /** Absent on a surface that has no bulk redraw (the /ui harness's read-only
   *  states), so the button simply is not rendered. */
  onRedrawAll?: () => void;
}) {
  const n = pending.length;
  return (
    <div className={`ws-wizard-refs${n ? " warn" : ""}`}>
      <div className="ws-wizard-refs-say">
        {n > 0 ? <AlertTriangle size={15} className="ic" />
          : drawing > 0 ? <Loader2 size={15} className="ic ns-spin" />
          : <Check size={15} className="ic" />}
        <div className="ws-wizard-refs-copy">
          <div className="t">
            {n > 0 ? `${refLabel(pending)} no reference sheet`
              : drawing > 0 ? `${drawing} reference sheet${drawing === 1 ? "" : "s"} drawing`
              : "Every character, location and prop has a reference."}
            {n > 0 && drawing > 0 && <span className="also"> · {drawing} already drawing</span>}
          </div>
          <div className="d">
            {n > 0
              ? "Without a sheet the model invents it at render time, and every block that stages it inherits the invention — cheaper to draw now than to re-render blocks later."
              : drawing > 0 ? "The cards fill in as they land."
              : "Nothing here is left for the model to invent."}
          </div>
          {n > 0 && (
            <div className="ws-wizard-refs-names">
              {pending.slice(0, REF_CHIPS).map((e) => (
                <button key={e.id} type="button"
                        title={`Open ${e.name} — write what it looks like, or upload your own`}
                        onClick={() => onOpen(e.id)}>
                  {e.name}
                </button>
              ))}
              {/* The rest are NAMED in the title rather than dropped — a count
                  with no way to see what it counts is the paragraph's problem
                  again, one step in. */}
              {n > REF_CHIPS && (
                <span className="more"
                      title={pending.slice(REF_CHIPS).map((e) => e.name).join(", ")}>
                  +{n - REF_CHIPS} more
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="ws-wizard-refs-act">
        <div className="ws-wizard-refs-on">
          <span className="ws-mlabel">Sheets drawn by</span>
          <div className="pick">
            <ImageModelPicker compact width={330} models={models}
                              value={model} onPick={onModel} />
          </div>
        </div>
        {n > 0 && (
          <button type="button" className="ws-wizard-refs-go" disabled={queuing}
                  title={`Draw a reference sheet for each of the ${n} without one`}
                  onClick={onGenerate}>
            {queuing ? <Loader2 size={13} className="ns-spin" /> : <ImagePlus size={13} />}
            Generate {n} sheet{n === 1 ? "" : "s"}
          </button>
        )}
        {/* REDRAW EVERYTHING, and it stays on screen when nothing is missing —
            that is when it is most wanted. The reasons to redraw are not
            "something is absent": the style changed, the image model changed,
            or a sheet pass drew the anchors and none of the views. It is the
            quiet variant beside the primary, because the primary is the one
            that costs nothing you already have. */}
        {redrawable > 0 && onRedrawAll && (
          <button type="button" className="ws-wizard-refs-redraw" disabled={queuing}
                  title={`Clear all ${redrawable} reference sheets and draw them `
                       + `again — a fresh anchor plate each, then every other view `
                       + `as one take. The old pictures stay in the library.`}
                  onClick={onRedrawAll}>
            {queuing ? <Loader2 size={12} className="ns-spin" /> : <RefreshCw size={12} />}
            Redraw all {redrawable}
          </button>
        )}
      </div>
    </div>
  );
}

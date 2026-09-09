// The save dialog behind "Save as new block…".
//
// The menu item has carried an ellipsis since it shipped and never opened
// anything — it fired straight away. What was missing is a real decision, and
// it is a decision because NEITHER ANSWER IS FREE:
//
//  * INSERT keeps story order, which is what `assemble_cut` renders: it orders
//    blocks by `idx`, so a shot cut from the middle belongs in the middle.
//    The cost is that every following block renumbers — and a clip's label is
//    a STORED snapshot of `idx` (see `syncBlocksToTimeline`), so all of their
//    labels go stale at once. That is what makes a save look like it
//    duplicated a shot: two clips end up reading the same "Block N" until the
//    editor next remounts and the labels heal.
//  * APPEND renumbers nobody and costs story order instead — the shot renders
//    at the END of the episode until it is moved.
//
// So the choice is offered here rather than picked for the user, and each
// option states its own consequence instead of leaving it to be discovered in
// a finished cut.
import React, { useState } from "react";
import { createPortal } from "react-dom";
import { CopyPlus, CornerDownRight, ListEnd } from "lucide-react";
import ModalShell from "../modals/ModalShell";

export type BlockPlacement = "insert" | "append";

/** One placement option.
 *
 * HOISTED, and that is not style. A component declared inside another is a new
 * TYPE on every render, so React unmounts the old subtree and mounts a fresh
 * one each time — measured here: the two buttons were replaced DOM nodes after
 * every click, which throws away focus and any transition mid-flight. */
function Opt({ id, icon, title, where, note, chip, chosen, onPick }: {
  id: BlockPlacement; icon: React.ReactNode; title: string;
  /** Where it ends up, in the storyboard's own words. The line people are
   *  actually choosing between, so it gets its own weight. */
  where: string;
  note: string; chip?: string;
  chosen: BlockPlacement; onPick: (p: BlockPlacement) => void;
}) {
  const on = chosen === id;
  return (
    <button
      className="ws-card sab-opt"
      aria-pressed={on}
      data-on={on || undefined}
      onClick={() => onPick(id)}
    >
      <span className="sab-tick" aria-hidden>
        <span className="sab-dot" />
      </span>
      <span className="sab-body">
        <span className="sab-title">
          <span className="sab-ico">{icon}</span>
          {title}
          {chip && <span className="sab-chip">{chip}</span>}
        </span>
        <span className="sab-where">{where}</span>
        <span className="sab-note">{note}</span>
      </span>
    </button>
  );
}

export default function SaveAsBlockModal({
  windowMs, sourceLabel, onSave, onClose,
}: {
  /** The trimmed window this will become, so the dialog names what is being
   *  saved rather than only where it goes. */
  windowMs: number;
  /** The clip's own label ("Block 4"), or null for a blockless promotion —
   *  which has no anchor to insert after, so it can only append. */
  sourceLabel: string | null;
  onSave: (placement: BlockPlacement) => void;
  onClose: () => void;
}) {
  // A promotion has no anchor: `handle_block_from_clip` appends it either way,
  // so offering the choice would be a control that changes nothing.
  const anchored = !!sourceLabel;
  const [placement, setPlacement] = useState<BlockPlacement>("insert");
  const chosen = anchored ? placement : "append";

  // PORTALLED TO <body>, and this one is not optional. `ModalShell` renders
  // its `.ws-scrim` in place, and the timeline's own `.ws-slab.ns-l2` carries
  // `backdrop-filter: blur(40px)` — which makes it the containing block for
  // every `position: fixed` descendant. Mounted where it is used, the scrim
  // resolved against the SLAB and opened inside the timeline instead of over
  // the app (measured: 330x358 against a 416x361 viewport). `BlockActionModal`
  // portals from this same mount point for exactly this reason, and the same
  // rule applies one layer in (`.ns-l3`).
  return createPortal(
    <ModalShell
      icon={<CopyPlus size={15} />}
      title="Save as new block"
      context={`${(windowMs / 1000).toFixed(1)}s${sourceLabel ? ` from ${sourceLabel}` : ""}`}
      width={460}
      onClose={onClose}
      footer={
        <>
          <button className="ws-ghost" onClick={onClose}>Cancel</button>
          <button className="ws-primary" onClick={() => { onSave(chosen); onClose(); }}>
            <CopyPlus size={13} />Save block
          </button>
        </>
      }
    >
      <div className="ws-modal-body">
        <p className="sab-lede">
          The trim becomes its own block, cut to exactly what is on screen — same
          beats, same settings. Only <b>where it lands</b> changes.
        </p>
        <div className="sab-opts">
          {anchored && (
            <Opt
              chosen={chosen} onPick={setPlacement}
              id="insert"
              chip="default"
              icon={<CornerDownRight size={13} />}
              title="Insert here"
              where={`Straight after ${sourceLabel}`}
              note="Renders in the right place. Every later block shifts up one number."
            />
          )}
          <Opt
            chosen={chosen} onPick={setPlacement}
            id="append"
            icon={<ListEnd size={13} />}
            title="Add to the end"
            where={anchored ? "Last in the storyboard" : "Last in the newest storyboard"}
            note={anchored
              ? "Renumbers nothing. Renders at the end of the episode until you move it."
              : "This clip has no block to sit beside, so it goes on the end."}
          />
        </div>
      </div>
    </ModalShell>,
    document.body,
  );
}

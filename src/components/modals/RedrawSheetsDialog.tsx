// The confirmation behind the cast & world step's "Redraw all N" button.
//
// A pop-up rather than an inline chip, for `DeleteSceneDialog`'s reason: the
// two things this does are not small and neither is visible from the button.
// It UNLINKS every reference the bible has — recoverable, but not obviously so
// — and it spends a render per entry plus a whole H3 take per character and
// per location. Both belong in front of the decision rather than behind it.
//
// It takes an `onConfirm` rather than owning the work, which is the opposite
// call from `DeleteSceneDialog` and deliberate: what has to happen here is a
// detach and a queue across three kinds, on a lane resolved once, using the
// wizard's own image pick and its own world — all of it state this component
// would have to be handed anyway. What is genuinely shared is the SENTENCE,
// and that is what lives here.
import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { Loader2, RefreshCw } from "lucide-react";
import ModalShell from "./ModalShell";

export default function RedrawSheetsDialog({
  characters, environments, props: propCount, busy, onCancel, onConfirm,
}: {
  characters: number;
  environments: number;
  props: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    // Escape backs out, but not mid-queue: half the bible is already detached
    // by then and closing the dialog would hide the only thing saying so.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  const total = characters + environments + propCount;
  // The KINDS are named because they are redrawn differently and cost
  // differently — a prop is one picture, a character and a location are each a
  // plate plus a whole take. "12 entries" hides both.
  const parts = [
    [characters, "character", "a face and body plate, then a six-view turnaround"],
    [environments, "location", "a master plate, then all four angles in one take"],
    [propCount, "prop", "one product shot"],
  ] as const;

  return createPortal(
    <ModalShell
      z={150} width={480} tone="danger"
      onClose={busy ? () => {} : onCancel}
      icon={<RefreshCw size={15} />}
      title="Redraw every reference sheet"
      context={`${total} entr${total === 1 ? "y" : "ies"}`}>
      <div className="ws-modal-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>
          Clear what the bible has and draw it again, from the image model in
          the bar above.
        </div>
        <ul className="sb-delnote">
          {parts.filter(([n]) => n > 0).map(([n, one, what]) => (
            <li key={one}>
              <b>{n} {one}{n === 1 ? "" : "s"}</b> — {what}.
            </li>
          ))}
          {/* The reassurance, and it is the whole reason this is not a delete:
              `detachRef` touches `bible_assets` and nothing else. */}
          <li>
            The pictures on file now are UNLINKED, not deleted — they stay in
            the library, and the recycle bin is still the deliberate place to
            discard them.
          </li>
          <li>
            Anything already mid-draw is left alone rather than queued twice.
          </li>
        </ul>
        <div className="mono" style={{ fontSize: 11, color: "#5e6678" }}>
          {total} render{total === 1 ? "" : "s"} plus{" "}
          {characters + environments} take{characters + environments === 1 ? "" : "s"}.
        </div>
      </div>
      <div className="ws-modal-foot">
        <span className="sum" />
        {/* Cancel holds the focus: Enter and Escape both back out, so the safe
            answer is the one a reflex reaches. */}
        <button className="ws-ghost" autoFocus disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="ws-primary danger" disabled={busy || !total}
                onClick={onConfirm}>
          {busy ? <Loader2 size={13} className="ns-spin" /> : <RefreshCw size={13} />}
          {busy ? "Queueing…" : `Redraw all ${total}`}
        </button>
      </div>
    </ModalShell>,
    document.body);
}

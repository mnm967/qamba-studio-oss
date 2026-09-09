// The two-step for a scene delete, shared by the storyboard page's scene menu
// and the scene editor's own footer.
//
// A pop-up rather than the inline `.ws-confirm` chip the retake confirm uses,
// because the two actions are not the same size: a retake spends GPU time and
// adds a take you can throw away, and this removes the scene, its shots and
// every line in them for good. It also has room to SAY that, which a chip in a
// crowded header row does not.
//
// It OWNS THE DELETE rather than taking an `onConfirm`, and that is what makes
// one component serve both callers: the in-flight state, the retry after a
// failure and the partial-failure notice are the same three states wherever
// the button was pressed, and a second copy of them is a second copy to get
// wrong. The caller supplies only what happens afterwards.
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import ModalShell from "./ModalShell";
import { deleteScene } from "../../lib/db/director";
import type { Scene } from "../../lib/db/types";

export default function DeleteSceneDialog({
  scene, shots, blocks, onCancel, onDeleted,
}: {
  /** Passed BY VALUE, never looked up: the row is gone the moment the delete
   *  lands, and a dialog that reads it out of a live query unmounts itself
   *  mid-sentence — taking the partial-failure notice with it. */
  scene: Scene;
  shots: number;
  blocks: number;
  onCancel: () => void;
  /** The delete has landed and the user has seen anything there was to see.
   *  On the storyboard page this clears the row's local state; in the scene
   *  editor it closes the modal, which is showing a scene that no longer
   *  exists. */
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set only when the delete SUCCEEDED and part of the cleanup after it did
  // not. Distinct from `error` because there is nothing to retry and nothing
  // to back out of — the scene is gone either way.
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    // Escape backs out, but not while the delete is in flight and not once it
    // has landed: at that point the only button left is the one that has to
    // be pressed for `onDeleted` to run.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && !warning) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy, warning]);

  const label = scene.slug ?? `SCENE ${scene.idx + 1}`;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await deleteScene(scene.id);
      // A clean delete needs no receipt — the list behind it is the receipt.
      if (!res.warning) { onDeleted(); return; }
      setWarning(res.warning);
    } catch (e) {
      // Nothing was destroyed, so the dialog stays and the retry is one click.
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <ModalShell
      z={150} width={460} tone="danger"
      onClose={busy ? () => {} : warning ? onDeleted : onCancel}
      icon={warning ? <AlertTriangle size={15} /> : <Trash2 size={15} />}
      title={warning ? "Scene deleted" : "Delete scene"}
      context={`S${scene.idx + 1} · ${label}`}>
      <div className="ws-modal-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {warning ? (
          <>
            <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>
              <b>{label}</b> is gone — but {warning}.
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "#9aa4b6" }}>
              Both are recoverable and neither loses work: drag any scene to
              re-close the numbering, and a re-launch re-plans the blocks from
              the scenes that are left.
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>
              Remove <b>{label}</b> from this episode
              {shots ? <> along with its {shots} shot{shots === 1 ? "" : "s"}</> : null}?
            </div>
            {/* What follows from it, said before rather than discovered after
                — each is a real consequence, and the last is the reassurance
                that stops this reading worse than it is. */}
            <ul className="sb-delnote">
              <li>The scenes after it move up, so every later number changes.</li>
              <li>
                The block plan goes stale
                {blocks ? <> — including {blocks} block{blocks === 1 ? "" : "s"} of this scene</> : null}
                . Re-launch the render to rebuild it.
              </li>
              <li>Panels and stills already drawn stay in the library.</li>
            </ul>
            <div className="mono" style={{ fontSize: 11, color: "#5e6678" }}>
              This cannot be undone.
            </div>
          </>
        )}
      </div>
      <div className="ws-modal-foot">
        {/* A failure is reported HERE rather than on the page behind, whose
            note strip is styled green for a success — and this is the one
            place a retry costs no clicks. */}
        <span className="sum" style={error ? { color: "#ff8080" } : undefined}>{error}</span>
        {warning ? (
          <button className="ws-primary" autoFocus onClick={onDeleted}>Close</button>
        ) : (
          <>
            {/* Cancel holds the focus, so Enter and Escape both back out. The
                safe answer is the one a reflex reaches. */}
            <button className="ws-ghost" autoFocus disabled={busy} onClick={onCancel}>Cancel</button>
            <button className="ws-primary danger" disabled={busy} onClick={() => void run()}>
              {busy ? <Loader2 size={13} className="ns-spin" /> : <Trash2 size={13} />}
              {busy ? "Deleting…" : "Delete scene"}
            </button>
          </>
        )}
      </div>
    </ModalShell>,
    document.body);
}

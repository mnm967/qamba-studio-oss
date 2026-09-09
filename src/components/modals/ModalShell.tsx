// L3 modal frame from the design file: blurred scrim, 28px-radius glass,
// header (34px accent icon · title · mono context · close), optional footer
// (mono summary left, actions right). Every workspace modal composes this.
import React from "react";
import { Loader2, X } from "lucide-react";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";

/** The body a data-backed modal renders while its first fetch is in flight.
 *  Exists so "open the modal" and "have the data" stop being the same moment:
 *  a modal that returns null until its loader resolves is a click that does
 *  nothing on screen for the length of the round trips. */
export function ModalLoading({ label = "Loading…", minH = 180, error = null }: {
  label?: string; minH?: number; error?: Error | null;
}) {
  // An error is not "still loading": a spinner over a failed fetch spins
  // forever and reads as a hang. Say what happened instead.
  if (error) {
    return (
      <div className="ws-modalload" style={{ minHeight: minH, color: "#e46e6e" }}>
        <span>Couldn't load — {String(error.message ?? error).slice(0, 140)}</span>
      </div>
    );
  }
  return (
    <div className="ws-modalload" style={{ minHeight: minH }}>
      <Loader2 size={16} className="ns-spin" />
      <span>{label}</span>
    </div>
  );
}

/**
 * THE MODAL TIERS, so a nested picker cannot open BEHIND the modal that opened
 * it — which is exactly what happened: `.ws-scrim`'s CSS default is a bare
 * `z-index`, and the four modals that use the raw scrim instead of this shell
 * inherited a number ABOVE the one every "opened from a modal" surface uses.
 * The reference picker rendered, took the clicks, and sat under the panel that
 * summoned it.
 *
 * Two tiers is all there is, and the rule is positional rather than numeric:
 * a modal is Z_MODAL, and anything a modal opens is Z_OVER_MODAL. A third
 * level would need a third name, not a bigger number.
 */
export const Z_MODAL = 94;
export const Z_OVER_MODAL = 150;

export default function ModalShell({
  icon, title, context, width, tall = false, maxH, z = Z_MODAL, tone = "accent",
  loading = false, loadingLabel, loadError = null,
  children, footer, headActions, onClose,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  context?: React.ReactNode;
  width: number;
  /** full-height modal (scene editor, camera picker, wizard) */
  tall?: boolean;
  maxH?: number;
  z?: number;
  /** The head icon's colour. `danger` for a modal whose primary action
   *  destroys something — a blue icon over a Delete button reads as a
   *  different dialog than the one it is. */
  tone?: "accent" | "danger";
  /** First fetch still in flight: render the frame now, a spinner body in
   *  place of children. The scrim, title and close all work immediately. */
  loading?: boolean;
  loadingLabel?: string;
  /** The loader failed — the body says so instead of spinning forever. */
  loadError?: Error | null;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  /** Sits left of the close button: state that belongs to the whole modal
   *  (record status, dirty flag, lock, prev/next) rather than to a field. */
  headActions?: React.ReactNode;
  onClose?: () => void;
}) {
  const ws = useWorkspaceStore();
  const close = onClose ?? ws.closeModal;
  return (
    <div className="ws-scrim" style={{ zIndex: z }}
         onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="ws-modal ns-l3 ns-rise"
           style={{ width: "100%", maxWidth: width, ...(tall ? { height: "100%" } : {}),
                    ...(maxH ? { maxHeight: maxH } : {}) }}>
        <div className="ws-modal-head">
          <span className={"ws-modal-ico" + (tone === "danger" ? " danger" : "")}>{icon}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ws-modal-t">{title}</div>
            {context && <div className="ws-modal-c">{context}</div>}
          </div>
          {headActions}
          <button className="ws-icobtn lg" onClick={close}><X size={16} /></button>
        </div>
        {loading ? <ModalLoading label={loadingLabel} error={loadError} /> : children}
        {!loading && footer && <div className="ws-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Flat inner card (glass panels contain flat cards, never nested glass). */
export function Card({ label, children, style }: {
  label?: string; children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 9, ...style }}>
      {label && <span className="ws-mlabel">{label}</span>}
      {children}
    </div>
  );
}

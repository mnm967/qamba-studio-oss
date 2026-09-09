// Full-bleed image viewer, shared by the Bible entry modal and the one-shot
// wizard. Portalled to <body> for the usual reason: `.ns-l3` carries a
// backdrop-filter, which makes any modal a containing block for fixed
// descendants — a viewer rendered inside one opens *within* the panel that
// opened it, clipped by its overflow.
import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { assetUrl } from "../../lib/db/assets";
import type { Asset } from "../../lib/db/types";

export default function Lightbox({ assets, index, onClose, onStep, actions }: {
  assets: Asset[];
  index: number;
  onClose: () => void;
  onStep: (d: number) => void;
  /** Extra controls for the slide on screen, rendered beside the meta pill —
   *  e.g. the storyboard views' "Redraw…", which needs to know which asset
   *  (and so which beat) is currently showing. */
  actions?: (asset: Asset, index: number) => React.ReactNode;
}) {
  // Escape and the arrows belong on the window: the old handler sat on a div
  // that never held focus, so the keys did nothing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onStep(-1);
      else if (e.key === "ArrowRight") onStep(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onStep]);

  const a = assets[index];
  if (!a) return null;
  return createPortal(
    <div className="ws-lightbox" onClick={onClose}>
      <img src={assetUrl(a) ?? undefined} alt="" onClick={(e) => e.stopPropagation()} />
      <button className="ws-lb-close" onClick={onClose} title="Close (Esc)"><X size={18} /></button>
      {assets.length > 1 && (
        <>
          <button className="ws-lb-nav l" title="Previous (←)"
                  onClick={(e) => { e.stopPropagation(); onStep(-1); }}><ChevronLeft size={20} /></button>
          <button className="ws-lb-nav r" title="Next (→)"
                  onClick={(e) => { e.stopPropagation(); onStep(1); }}><ChevronRight size={20} /></button>
        </>
      )}
      <div className="ws-lb-meta mono" onClick={(e) => e.stopPropagation()}>
        {/* Not every asset carries dimensions (an older row, an upload that
            skipped probing) — "× · 1/1" reads like a broken template. */}
        {a.width && a.height ? `${a.width}×${a.height} · ` : ""}{index + 1}/{assets.length}
        {actions?.(a, index)}
        <a href={assetUrl(a) ?? "#"} target="_blank" rel="noreferrer" title="Open the original">
          <Download size={12} />
        </a>
      </div>
    </div>,
    document.body);
}

/** Step within a list, wrapping at both ends. The callers all did this by hand. */
export const stepIndex = (i: number | null, d: number, len: number) =>
  i == null || !len ? null : (i + d + len) % len;

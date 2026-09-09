// The "new bible entry" modal as the WIZARD opens it: nested inside a
// wizard-shaped scrim rather than routed through the store.
//
// Here because the one thing this wiring can get wrong is invisible in code
// and obvious in a picture, and this repo has already paid for it once — the
// reference picker "rendered, took the clicks, and sat under the panel that
// summoned it". Three claims only a screenshot settles:
//
//   1. the nested modal paints ABOVE the wizard's own scrim, not behind it;
//   2. its scrim covers the VIEWPORT. Measured here, an in-place child of the
//      wizard's own full-viewport scrim would ALSO have — a fixed child
//      resolves to the padding BOX, which includes the padding — so this
//      screen is what stops the portal being justified by a reason that is
//      not true. What it really buys is an opener-independent modal and an
//      unambiguous z; see NewEntryModal's `nested` prop;
//   3. the kind switcher offers THREE kinds, because step 2 renders three
//      columns and a lore entry saved from here would be a row nothing shows.
//
// The real screen is behind a sign-in, a project, an interview and a
// several-minute plan. This writes nothing: `NewEntryModal` reads nothing on
// mount and only touches the database on save, which needs a real project id.
import React, { useState } from "react";
import { Sparkles } from "lucide-react";
import NewEntryModal from "./NewEntryModal";

export default function NestedEntryDemo() {
  const [open, setOpen] = useState(true);
  const [closed, setClosed] = useState(0);

  return (
    // A stand-in for the wizard's own frame, copied from WizardModal's outer
    // return: the same `.ws-scrim` (backdrop-filter, 34px padding) at the same
    // z, wrapping the same opaque non-.ns-l3 panel.
    <div className="ws-scrim" style={{ zIndex: 95, background: "rgba(4,6,10,.88)", padding: 34 }}>
      <div style={{ width: "100%", maxWidth: 1180, height: "100%", display: "flex",
                    flexDirection: "column", borderRadius: 26, overflow: "hidden",
                    background: "rgba(13,17,25,.94)", border: "1px solid rgba(255,255,255,.1)" }}>
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 16,
                      padding: "15px 20px", borderBottom: "1px solid rgba(255,255,255,.07)" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 600 }}>
            <Sparkles size={15} style={{ color: "#c97aff" }} />One-shot
          </span>
          <span className="mono" style={{ fontSize: 11, color: "#5e6678" }}>
            cast &amp; world — the wizard stays open behind
          </span>
        </div>
        <div style={{ flex: 1, padding: 20, display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(158px, 1fr))",
                      gap: 12, alignContent: "start" }}>
          {/* The dashed tile, at the size the real grid gives it. */}
          <button data-testid="add-character" onClick={() => setOpen(true)}
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                           minHeight: 104, borderRadius: 18, cursor: "pointer",
                           border: "1px dashed #5aa2ff55", background: "#5aa2ff0a",
                           color: "#5aa2ff", fontSize: 13, fontWeight: 600 }}>
            + Add character
          </button>
          <div className="mono" data-testid="closed-count"
               style={{ gridColumn: "1 / -1", fontSize: 11, color: "#5e6678", marginTop: 8 }}>
            wizard still mounted · nested modal closed {closed}x
          </div>
        </div>
      </div>

      {open && (
        <NewEntryModal
          projectId="00000000-0000-4000-8000-000000000000"
          initialKind="character"
          kinds={["character", "environment", "prop"]}
          nested
          onCreated={() => {}}
          onClose={() => { setOpen(false); setClosed((n) => n + 1); }}
          onAskDirector={() => {}}
        />
      )}
    </div>
  );
}

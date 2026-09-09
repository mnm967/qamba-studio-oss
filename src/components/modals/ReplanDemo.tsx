// ReplanModal on its own, for /ui/replan.
//
// The modal itself is pure — props in, callbacks out — but the thing worth
// looking at is not the modal, it is the modal INSIDE THE WIZARD. `.ws-scrim`
// carries a `backdrop-filter`, which makes it a containing block for fixed
// descendants, so a nested scrim rendered in place resolves against the
// wizard's padding box instead of the viewport and leaves an unblurred border
// around the screen. That is why it portals to <body>, and it is not a thing
// unit tests can see. So this stands the real wizard shell up around it.
//
// Reaching the real one means signing in, opening a project, running an
// interview and waiting out a plan — a credential a test should not hold and a
// path an agent should not click through on someone's behalf.
import React, { useState } from "react";
import { Sparkles } from "lucide-react";
import ReplanModal, { type ReplanChoice } from "./ReplanModal";

export default function ReplanDemo() {
  const [open, setOpen] = useState(true);
  const [last, setLast] = useState<string>("");
  const q = new URLSearchParams(window.location.search);
  // `?blocker=…` exercises the disabled state; `?scenes=`/`?beats=` the copy
  // that quotes a price off the shot count.
  const blocker = q.get("blocker");
  const scenes = Number(q.get("scenes") ?? 8);
  const beats = Number(q.get("beats") ?? 41);

  return (
    // The wizard's own shell, verbatim from WizardModal's return, so the
    // stacking context under the popup is the real one.
    <div className="ws-scrim" style={{ zIndex: 95, background: "rgba(4,6,10,.88)", padding: 34 }}>
      <div style={{ width: "100%", maxWidth: 1180, height: "100%", display: "flex",
                    flexDirection: "column", borderRadius: 26, overflow: "hidden",
                    background: "rgba(13,17,25,.94)", border: "1px solid rgba(255,255,255,.1)" }}>
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 16,
                      padding: "15px 20px", borderBottom: "1px solid rgba(255,255,255,.07)" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 600 }}>
            <Sparkles size={15} style={{ color: "#c97aff" }} />One-shot
          </span>
        </div>
        <div style={{ flex: 1, padding: 24 }}>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Here's the episode. Change anything.</div>
          <div className="mono" data-testid="replan-result"
               style={{ fontSize: 11, color: "#5e6678", marginTop: 10 }}>
            {last || "…"}
          </div>
          {!open && (
            <button className="ws-pillbtn" style={{ height: 28, marginTop: 12 }}
                    onClick={() => setOpen(true)}>Re-plan</button>
          )}
        </div>
      </div>
      {open && (
        <ReplanModal
          scenes={scenes} beats={beats} blocker={blocker}
          onEditHere={(note) => { setLast(`edit-here: ${note}`); setOpen(false); }}
          onNewVersion={(c: ReplanChoice) =>
            setLast(`new-version: note=${c.note} prev=${c.withPrevious} panels=${c.panels}`)}
          onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

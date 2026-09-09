// "Re-plan" — the two things that phrase can mean, as one decision.
//
// EDIT THESE SCENES is what the button did before: the director rewrites the
// scenes on screen, in this conversation, with the tools it already has. Free,
// instant, and it keeps every panel, still and block that already matches.
//
// WRITE A NEW VERSION runs the whole staged studio on the pod — writer, story
// editor, dialogue polish, per-character voice, continuity, cinematographer,
// plus every deterministic validator between them — and lands as version N+1
// beside this one. Genuinely different structure; minutes, and a new set of
// beats that the current panels no longer describe.
//
// Offering both from one popup is the point: the note is the same sentence
// either way, and which route it should take depends entirely on how big the
// change is — which the person typing it knows and the button never could.
import React, { useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, MessageSquare, RefreshCw, Sparkles } from "lucide-react";
import ModalShell from "./ModalShell";

export interface ReplanChoice {
  note: string;
  withPrevious: boolean;
  panels: boolean;
}

export default function ReplanModal({
  scenes, beats, blocker, busy, onEditHere, onNewVersion, onClose,
}: {
  scenes: number;
  /** Panels are one render per beat, so the count IS the price. */
  beats: number;
  /** Why "write a new version" is unavailable, or null. */
  blocker: string | null;
  busy?: boolean;
  onEditHere: (note: string) => void;
  onNewVersion: (choice: ReplanChoice) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [withPrevious, setWithPrevious] = useState(true);
  const [panels, setPanels] = useState(false);
  const has = !!note.trim();
  const choice = { note, withPrevious, panels };

  return createPortal(
    <ModalShell
      z={150} width={560} maxH={600} onClose={onClose}
      icon={<RefreshCw size={15} />} title="Re-plan"
      context={`${scenes} scene${scenes === 1 ? "" : "s"} · ${beats} shot${beats === 1 ? "" : "s"} on screen`}>
      <div className="ns-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto",
                                          padding: "16px 18px", display: "flex",
                                          flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>What should change?</div>
          <textarea className="ws-input ns-scroll" rows={5} autoFocus value={note}
                    onChange={(e) => setNote(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter is a newline here — this is a brief, not a chat
                      // line, and the two routes below are not interchangeable
                      // enough for one of them to own the Enter key.
                      if (e.key === "Escape") onClose();
                    }}
                    placeholder={"Cut the training scene and give Miko more to do in the observatory. "
                                 + "Keep the ending."}
                    style={{ fontSize: 12.5, lineHeight: 1.55, width: "100%" }} />
        </div>

        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={withPrevious} style={{ marginTop: 2 }}
                 onChange={(e) => setWithPrevious(e.target.checked)} />
          <span style={{ fontSize: 12 }}>
            Show the writer the current plan
            <div style={{ fontSize: 11, color: "#8b93a7", marginTop: 2 }}>
              {withPrevious
                ? "It revises what is on screen, so anything your note doesn't touch survives."
                : "It writes from the brief alone — a genuinely different structure, and nothing "
                  + "from this version is guaranteed to come back."}
            </div>
          </span>
        </label>

        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={panels} style={{ marginTop: 2 }}
                 onChange={(e) => setPanels(e.target.checked)} />
          <span style={{ fontSize: 12 }}>
            Draw storyboard panels for the new shots
            <div style={{ fontSize: 11, color: "#8b93a7", marginTop: 2 }}>
              {panels
                ? `One render per shot — ${beats} of them at this length, `
                  + "drawn after the plan lands."
                : "The new version arrives as prose, in a couple of minutes. "
                  + "Key stills stay one click away, and panels can be drawn later."}
            </div>
          </span>
        </label>

        {/* Said once, plainly, because it is the thing people assume goes
            wrong: a new version does NOT redraw the bible. The planner reuses
            every entry it can match and only draws sheets for something it had
            to invent. */}
        <div style={{ display: "flex", gap: 8, padding: "9px 11px", borderRadius: 12,
                      border: "1px solid rgba(255,255,255,.07)", background: "rgba(255,255,255,.025)",
                      fontSize: 11.5, color: "#9aa4b6", lineHeight: 1.5 }}>
          <Sparkles size={13} style={{ flexShrink: 0, marginTop: 1, color: "#c97aff" }} />
          <span>
            Your cast, locations and props are reused as they stand — nothing already
            drawn is redrawn. A new version is added beside this one; neither replaces
            the other, and the storyboard page keeps both.
          </span>
        </div>
      </div>

      <div className="ws-modal-foot">
        <span className="mono" style={{ fontSize: 10.5, color: "#5e6678", flex: 1,
                                        minWidth: 0, overflow: "hidden",
                                        textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {blocker ?? (has ? "" : "say what should change")}
        </span>
        <button className="ws-ghost" disabled={!has || busy}
                title="The director edits these scenes in the chat — free, and it keeps the panels you already have"
                onClick={() => onEditHere(note)}>
          <MessageSquare size={13} />Edit these scenes
        </button>
        <button className="ws-primary" disabled={!has || !!blocker || busy}
                title={blocker ?? "The full planning studio writes a new version in the studio cloud"}
                onClick={() => onNewVersion(choice)}>
          {busy ? <Loader2 size={13} className="ns-spin" /> : <RefreshCw size={13} />}
          Write a new version
        </button>
      </div>
    </ModalShell>,
    document.body);
}

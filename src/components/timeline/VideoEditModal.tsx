// AI video edit — its own popup, because edit mode's INPUT is the clip's
// video (H3 r2v with the source as <Video 1>), not the block's reference
// plan. The inspector's old one-line input hid that entirely: you couldn't
// see what you were editing, couldn't add image refs, and the queue row it
// produced said only "AI edit". Portals to <body> — a fixed overlay inside
// the timeline panels would be clipped by their overflow.
import React, { useState } from "react";
import { createPortal } from "react-dom";
import { Film, ImagePlus, Trash2, Wand2, X } from "lucide-react";
import AssetPickerModal from "../modals/AssetPickerModal";
import { assetUrl } from "../../lib/db/assets";
import { enqueueJob, USER_PRIORITY } from "../../lib/db/jobs";
import type { Asset } from "../../lib/db/types";

export default function VideoEditModal({
  source, blockId, projectId, onClose,
}: {
  source: Asset;
  blockId?: string | null;
  projectId?: string | null;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [refs, setRefs] = useState<{ asset: Asset; label: string }[]>([]);
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const queue = async () => {
    if (!prompt.trim()) { setNote("Say what should change."); return; }
    setBusy(true);
    try {
      await enqueueJob({
        kind: "video_edit", lane: "gpu", priority: USER_PRIORITY,
        project_id: projectId ?? undefined,
        payload: {
          source_asset_id: source.id,
          prompt: prompt.trim(),
          ref_asset_ids: refs.map((r) => r.asset.id),
          block_id: blockId ?? undefined,
          label: `AI edit · ${(source.b2_key.split("/").pop() ?? "clip").slice(0, 24)}`,
          user_edit: true,
        },
      });
      setNote("Queued — the edit lands as a new asset (and a new take when the clip belongs to a block).");
      setTimeout(onClose, 900);
    } catch (e) {
      setNote(`Could not queue: ${String(e).slice(0, 120)}`);
    } finally { setBusy(false); }
  };

  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: 200, display: "grid", placeItems: "center",
                  background: "rgba(4,6,10,.66)", backdropFilter: "blur(6px)" }}
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: 620, maxWidth: "94vw", maxHeight: "88vh", overflowY: "auto",
                    borderRadius: 20, background: "#10141d", border: "1px solid rgba(255,255,255,.1)",
                    padding: 18, display: "flex", flexDirection: "column", gap: 13 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <Film size={15} style={{ color: "#c97aff" }} />
          <span style={{ fontSize: 14.5, fontWeight: 600 }}>AI edit</span>
          <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
            the source video is the model's input — framing, timing and subjects
            are preserved except where you change them
          </span>
          <span style={{ flex: 1 }} />
          <button className="ws-microbtn sq" onClick={onClose}><X size={13} /></button>
        </div>

        <video src={assetUrl(source) ?? undefined} controls muted playsInline preload="metadata"
               style={{ width: "100%", borderRadius: 14, background: "#000",
                        border: "1px solid rgba(255,255,255,.08)" }} />

        <textarea rows={3} className="ws-input" value={prompt} autoFocus
                  placeholder="What changes — e.g. make it night; rain streaks the windows; her jacket is now oxblood red"
                  onChange={(e) => setPrompt(e.target.value)}
                  style={{ fontSize: 13.5, lineHeight: 1.6 }} />

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
            optional image refs (a look, a wardrobe change, a face to hold)
          </span>
          <span style={{ flex: 1 }} />
          {refs.map((r, i) => (
            <span key={r.asset.id} style={{ position: "relative", width: 44, height: 44,
                                            borderRadius: 10, overflow: "hidden",
                                            border: "1px solid rgba(255,255,255,.12)" }}>
              <img src={assetUrl(r.asset) ?? undefined} alt=""
                   style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              <button onClick={() => setRefs(refs.filter((_, j) => j !== i))}
                      title="Remove"
                      style={{ position: "absolute", right: 1, top: 1, width: 16, height: 16,
                               display: "grid", placeItems: "center", borderRadius: 6,
                               background: "rgba(7,9,14,.8)", border: 0, color: "#ff8080",
                               cursor: "pointer" }}>
                <Trash2 size={9} />
              </button>
            </span>
          ))}
          <button className="ws-microbtn" onClick={() => setPicking(true)}
                  style={{ padding: "0 10px" }}>
            <ImagePlus size={12} /> add
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {note && <span className="mono" style={{ fontSize: 11.5, color: "#6fd08c", flex: 1 }}>{note}</span>}
          <span style={{ flex: 1 }} />
          <button className="ws-ghost" onClick={onClose}>Cancel</button>
          <button className="ws-primary glow" disabled={busy} onClick={() => void queue()}>
            <Wand2 size={14} /> Queue edit
          </button>
        </div>
      </div>

      {picking && (
        <AssetPickerModal
          projectId={projectId ?? null}
          title="Reference images for this edit"
          context="staged beside the source video (H3 r2v)"
          multi capacity={8 - refs.length}
          used={new Set(refs.map((r) => r.asset.id))}
          onClose={() => setPicking(false)}
          onPick={(picks) => setRefs([...refs,
            ...picks.map((p) => ({ asset: p.asset, label: p.label }))].slice(0, 8))}
        />
      )}
    </div>,
    document.body,
  );
}

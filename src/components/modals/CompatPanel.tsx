// "Will this run here?" — one panel, shown both before an import (from the
// Civitai detail screen) and after one (in the import report).
//
// It is the SAME component in both places on purpose. The pre-import answer
// and the post-import answer are the same question asked of the same graph,
// and two renderings of it would drift — which is how a workflow gets a green
// tick on one screen and a red one on the next.
//
// The design rule throughout: every number says where it came from. A weight
// sized by `stat` and a weight sized by reading "14B_fp8" off its own filename
// are different kinds of fact, and a panel that presents them identically is
// inviting someone to trust the second one as far as the first.
import React, { useState } from "react";
import {
  AlertTriangle, Check, ChevronDown, Cpu, Download, ExternalLink, HardDrive, Package,
} from "lucide-react";
import {
  VERDICT_COLOR, VERDICT_LABEL, type CompatReport, type SizeSource, type WeightNeed,
} from "../../lib/compat";
import { openExternal } from "../../lib/desktop";

const INK_MUTE = "#5e6678";

const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

/** How a size was arrived at. The wording is the disclaimer. */
const SOURCE: Record<SizeSource, { label: string; title: string }> = {
  disk: { label: "on disk", title: "measured — the file is here" },
  catalog: { label: "known", title: "the size this studio's own catalog records for that file" },
  filename: { label: "≈ est", title: "estimated from the parameter count and precision in the filename" },
  unknown: { label: "?", title: "nothing could size this file — the filename carries no parameter count" },
};

function WeightRow({ w }: { w: WeightNeed }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "3px 0", fontSize: 11.5 }}>
      {w.installed
        ? <Check size={11} style={{ color: "#6fd08c", flex: "none" }} />
        : <Download size={11} style={{ color: "#e8a13a", flex: "none" }} />}
      <span className="mono" style={{ flex: 1, minWidth: 0, overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap",
              color: w.installed ? "#c7cddb" : "#eaeef6" }} title={`${w.input} · ${w.class_type}`}>
        {w.name}
      </span>
      <span className="mono" style={{ color: INK_MUTE, fontSize: 10.5, flex: "none" }}
            title={SOURCE[w.from].title}>
        {w.mb != null ? gb(w.mb) : "size unknown"}
        {w.from !== "disk" && ` · ${SOURCE[w.from].label}`}
      </span>
    </div>
  );
}

export default function CompatPanel({ r, compact = false }: {
  r: CompatReport;
  /** the import report already has its own headings, so it wants the body only */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const color = VERDICT_COLOR[r.verdict];
  const absent = r.weights.filter((w) => !w.installed);
  const shown = open ? r.weights : absent.length ? absent : r.weights.slice(0, 4);

  return (
    <div className="ws-card" style={{ borderColor: `${color}44` }}>
      {!compact && <span className="ws-mlabel" style={{ color }}>WILL THIS RUN HERE</span>}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: compact ? 0 : 4 }}>
        <span className="mono" style={{
          fontSize: 10, padding: "2px 7px", borderRadius: 6, flex: "none", marginTop: 1,
          color, background: `${color}1a`, border: `1px solid ${color}3d`,
        }}>{VERDICT_LABEL[r.verdict]}</span>
        <span style={{ fontSize: 12, lineHeight: 1.5 }}>{r.headline}</span>
      </div>

      {/* missing node packs — the hard wall, and the one worth a link */}
      {r.nodes.missing.length > 0 && (
        <div style={{ marginTop: 9 }}>
          <span className="ws-mlabel">MISSING NODES ({r.nodes.missing.length} of {r.nodes.total})</span>
          {r.nodes.missing.slice(0, 8).map((m) => (
            <div key={m.class_type} style={{ display: "flex", gap: 7, alignItems: "baseline",
                                             padding: "3px 0", fontSize: 11.5 }}>
              <AlertTriangle size={11} style={{ color: "#e8734a", flex: "none" }} />
              <span className="mono" style={{ flex: 1, minWidth: 0, overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.class_type}</span>
              {m.url ? (
                <button className="mono" onClick={() => void openExternal(m.url!)}
                        style={{ fontSize: 10.5, color: "#5aa2ff", flex: "none" }}>
                  <Package size={10} style={{ marginBottom: -1 }} /> {m.pack}
                  <ExternalLink size={9} style={{ marginLeft: 3, marginBottom: -1, opacity: 0.7 }} />
                </button>
              ) : (
                // Never guess at a repository. Sending someone to install the
                // wrong pack is worse than telling them to search for it.
                <span className="mono" style={{ fontSize: 10.5, color: INK_MUTE, flex: "none" }}>
                  pack unknown
                </span>
              )}
            </div>
          ))}
          {r.nodes.missing.length > 8 && (
            <span style={{ fontSize: 11, color: INK_MUTE }}>
              …and {r.nodes.missing.length - 8} more
            </span>
          )}
        </div>
      )}

      {/* weights */}
      {r.weights.length > 0 && (
        <div style={{ marginTop: 9 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span className="ws-mlabel" style={{ flex: 1 }}>
              WEIGHTS ({r.weights.length - absent.length} of {r.weights.length} on disk)
            </span>
            {absent.length > 0 && (
              <span className="mono" style={{ fontSize: 10.5, color: "#e8a13a" }}>
                <HardDrive size={10} style={{ marginBottom: -1 }} />{" "}
                {r.downloadMb != null ? `${gb(r.downloadMb)} to fetch` : "size not fully known"}
              </span>
            )}
          </div>
          {shown.map((w) => <WeightRow key={w.name} w={w} />)}
          {!open && shown.length < r.weights.length && (
            <button onClick={() => setOpen(true)}
                    style={{ fontSize: 11, color: INK_MUTE, marginTop: 3 }}>
              <ChevronDown size={11} style={{ marginBottom: -2 }} /> show all {r.weights.length}
            </button>
          )}
        </div>
      )}

      {/* the estimate, and what it is not counting */}
      {r.vram && r.vram.peakMb != null && (
        <div style={{ marginTop: 9, display: "flex", gap: 7, alignItems: "flex-start" }}>
          <Cpu size={12} style={{ color: INK_MUTE, flex: "none", marginTop: 2 }} />
          <p style={{ fontSize: 11, color: INK_MUTE, margin: 0, lineHeight: 1.55 }}>
            Largest single weight <b style={{ color: "#c7cddb" }}>{gb(r.vram.peakMb)}</b> against{" "}
            <b style={{ color: "#c7cddb" }}>{gb(r.vram.budgetMb)}</b> on {r.vram.gpu}
            {r.vram.unified && " (60% of unified memory — the OS needs the rest)"}.
            {" "}ComfyUI loads the text encoder and the diffusion model one at a time, so the peak
            is the largest file rather than their total.
            {/* Say what the number excludes. Activations scale with the render
                size and this module will not invent a coefficient for them. */}
            {r.frame?.width ? ` This graph renders ${r.frame.width}×${r.frame.height}`
              + `${r.frame.length && r.frame.length > 1 ? ` × ${r.frame.length} frames` : ""}`
              + " — activations scale with that and are not in the figure." : ""}
            {r.vram.unsized > 0 && ` ${r.vram.unsized} file(s) could not be sized at all.`}
          </p>
        </div>
      )}
    </div>
  );
}

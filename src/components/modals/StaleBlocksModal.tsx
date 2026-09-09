// The review popup behind the director dock's stale banner: which blocks have
// drifted from the plan, which scene and shots each one covers, and a checkbox
// per block for the ones to re-render.
//
// WHY A POPUP RATHER THAN A BAR WITH ONE BUTTON. The bar's `Regenerate` queued
// EVERY stale block, which is the one thing a person with a $3.36/hr box does
// not want offered as a single click — and it named none of them, so the only
// way to find out what it was about to spend was to leave the dock for the
// storyboard. The list is also the answer to a question the bar could not ask:
// a block goes stale because a SCENE or a BEAT changed, so what you actually
// want to see is the shot text, not `b6`.
//
// It OWNS THE QUEUE, like DeleteSceneDialog owns its delete: the in-flight
// state, the partial-failure notice and the chain-gap warning are the same
// three states wherever it is opened from, and a second copy of them is a
// second copy to get wrong. The caller supplies only what happens afterwards.
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, Film, Loader2, RefreshCw } from "lucide-react";
import ModalShell from "./ModalShell";
import { loadBlockPlanDetail, type BlockIndexRow, type BlockPlanDetail } from "../../lib/db/director";
import { queueStaleRerenders } from "../../lib/db/jobs";
import { missingChainParents, selectedSeconds } from "../../lib/staleBlocks";
import { blockRef } from "../../../director/refs.js";

const secs = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
const clamp = (s: string, n = 150) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export default function StaleBlocksModal({
  blocks, projectId, episodeId, onClose, onQueued,
  /** Test/harness seam: the real loader reads Supabase, and the popup's whole
   *  claim — "these are the shots that changed" — is only checkable against
   *  fixture rows on a screen with no session. */
  loadDetail = loadBlockPlanDetail, queue = queueStaleRerenders,
}: {
  /** Passed BY VALUE from the dock's live block index. The rows go `queued`
   *  the moment this queues them, so a popup re-reading them live would empty
   *  its own list mid-sentence and take the receipt with it. */
  blocks: BlockIndexRow[];
  projectId?: string;
  episodeId?: string;
  onClose: () => void;
  /** What landed, for the dock to say in its own notice line. */
  onQueued: (msg: string) => void;
  loadDetail?: (ids: readonly string[]) => Promise<Map<string, BlockPlanDetail>>;
  /** Same seam, for the half that SPENDS money. The harness's blocks are
   *  fixtures, so the real one would insert `master_pass` rows against block
   *  ids that do not exist — a review screen must not be able to queue GPU
   *  work by being opened. */
  queue?: typeof queueStaleRerenders;
}) {
  const ordered = useMemo(() => [...blocks].sort((a, b) => a.idx - b.idx), [blocks]);
  // Everything checked to begin with: "re-render what drifted" is the common
  // intent, and the popup exists so that it is a reviewed click rather than a
  // blind one — not so that it takes N clicks to reach.
  const [picked, setPicked] = useState<string[]>(() => ordered.map((b) => b.id));
  const [detail, setDetail] = useState<Map<string, BlockPlanDetail> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadDetail(ordered.map((b) => b.id))
      .then((d) => { if (live) setDetail(d); })
      // The list is still usable without it — a block ref and a window are
      // enough to queue by — so a failed lookup shows an empty plan column
      // rather than an error page over a working control.
      .catch((e) => { console.warn("stale plan detail failed", e); if (live) setDetail(new Map()); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered.map((b) => b.id).join(",")]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const toggle = (id: string) =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const gap = useMemo(() => missingChainParents(picked, ordered), [picked, ordered]);
  const seconds = useMemo(() => selectedSeconds(picked, ordered), [picked, ordered]);

  const run = async () => {
    if (busy || !picked.length) return;
    setBusy(true);
    setError(null);
    try {
      const chosen = ordered.filter((b) => picked.includes(b.id));
      const { queued, failed, error: err } = await queue(chosen, { projectId, episodeId });
      if (queued.length) {
        onQueued(`Queued ${queued.length} re-render${queued.length === 1 ? "" : "s"} at your priority${
          failed ? ` — ${failed} could not be queued` : ""}.`);
        onClose();
      } else {
        setError(err ?? "Could not queue those re-renders.");
      }
    } catch (e) {
      setError(String((e as Error).message || e).slice(0, 240));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <ModalShell
      z={150} width={720} maxH={680}
      icon={<RefreshCw size={16} />}
      title="Blocks that have drifted from the plan"
      context={`${ordered.length} stale · ${picked.length} selected`}
      onClose={busy ? () => {} : onClose}
      footer={<>
        <span className="sum">
          {picked.length
            ? `${picked.length} block${picked.length === 1 ? "" : "s"} · ~${Math.round(seconds)}s of footage`
            : "nothing selected"}
        </span>
        <button className="ws-ghost" disabled={busy} onClick={onClose}>Close</button>
        <button className="ws-primary" disabled={busy || !picked.length}
                title={picked.length
                  ? `Re-render ${picked.length} block${picked.length === 1 ? "" : "s"}`
                  : "Check at least one block"}
                onClick={() => void run()}>
          {busy ? <Loader2 size={13} className="ns-spin" /> : <RefreshCw size={13} />}
          {busy ? "Queueing…" : `Regenerate ${picked.length || ""}`.trim()}
        </button>
      </>}
    >
      <div className="ws-modal-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: 12.5, lineHeight: 1.6, color: "#9aa4b6" }}>
          A scene, a shot or a bible entry changed after these rendered. The takes
          on the timeline are still the takes that rendered — nothing is broken —
          they just no longer match what the storyboard says.
        </div>

        <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
          <button className="ws-ghost" style={{ height: 27, fontSize: 11.5 }}
                  disabled={busy || picked.length === ordered.length}
                  onClick={() => setPicked(ordered.map((b) => b.id))}>Select all</button>
          <button className="ws-ghost" style={{ height: 27, fontSize: 11.5 }}
                  disabled={busy || !picked.length}
                  onClick={() => setPicked([])}>Clear</button>
        </div>

        {/* A chained block opens on its predecessor's FINAL FRAME, declared
            `fully_preserved` — so re-rendering the successor while the
            predecessor is still stale continues from the take that is about to
            be replaced. Named rather than force-included: a partial re-render
            is a legitimate thing to want. */}
        {!!gap.length && (
          <div className="ws-stalegap">
            <AlertTriangle size={13} style={{ flex: "0 0 auto", marginTop: 1 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              {gap.map((b) => blockRef(b.idx)).join(", ")}{" "}
              {gap.length === 1 ? "is" : "are"} still stale and{" "}
              {gap.length === 1 ? "is" : "are"} what your selection opens on — a chained
              block reuses its predecessor's final frame exactly, so it will
              continue from the take you are about to replace.
            </div>
            <button className="ws-ghost" style={{ height: 27, fontSize: 11.5, flex: "0 0 auto" }}
                    disabled={busy}
                    onClick={() => setPicked((cur) => [...new Set([...cur, ...gap.map((b) => b.id)])])}>
              Add {gap.length}
            </button>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {ordered.map((b) => {
            const on = picked.includes(b.id);
            const d = detail?.get(b.id);
            const open = expanded === b.id;
            const beats = d?.beats ?? [];
            const scenes = (d?.scenes ?? []).map((s) => s.slug ?? `S${s.idx + 1}`).join(" + ");
            const lines = beats.reduce((t, x) => t + x.lines, 0);
            return (
              <div key={b.id} className={"ws-stalerow" + (on ? " on" : "")}>
                <label className="pick" title={on ? "Leave this one alone" : "Include this block"}>
                  <input type="checkbox" checked={on} disabled={busy}
                         onChange={() => toggle(b.id)} />
                  <span className="box">{on && <Check size={11} />}</span>
                </label>
                <button className="main" onClick={() => setExpanded(open ? null : b.id)}
                        title={beats.length ? "Show the shots in this block" : "No shots recorded on this block"}>
                  <span className="hd">
                    <span className="mono rf">{blockRef(b.idx)}</span>
                    <span className="sc">{scenes || (detail ? "—" : "…")}</span>
                    <span style={{ flex: 1 }} />
                    <span className="mono mt">
                      {secs(b.t_end_ms - b.t_start_ms)}
                      {beats.length ? ` · ${beats.length} shot${beats.length === 1 ? "" : "s"}` : ""}
                      {lines ? ` · ${lines} line${lines === 1 ? "" : "s"}` : ""}
                    </span>
                  </span>
                  {!open && !!beats.length && (
                    <span className="pv">{clamp(beats[0].action || "—", 110)}</span>
                  )}
                  {open && (
                    <span className="shots">
                      {beats.map((t, i) => (
                        <span key={t.id} className="shot">
                          <span className="mono n">{i + 1}</span>
                          <span className="tx">
                            {clamp(t.action || "—")}
                            {t.camera && <em>{clamp(t.camera, 70)}</em>}
                          </span>
                          {!!t.lines && (
                            <span className="mono ln" title={`${t.lines} spoken line${t.lines === 1 ? "" : "s"}`}>
                              {t.lines}L
                            </span>
                          )}
                        </span>
                      ))}
                      {!beats.length && <span className="tx">No shots recorded on this block.</span>}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {error && (
          <div className="ws-stalegap bad">
            <AlertTriangle size={13} style={{ flex: "0 0 auto", marginTop: 1 }} />
            <div style={{ flex: 1, minWidth: 0 }}>{error}</div>
          </div>
        )}

        <div className="mono" style={{ fontSize: 10.5, color: "#5e6678", lineHeight: 1.6 }}>
          <Film size={10} style={{ verticalAlign: -1, marginRight: 5 }} />
          Each one queues a master pass at your own priority, ahead of the episode
          queue, with its references recomputed against the current bible.
        </div>
      </div>
    </ModalShell>,
    document.body,
  );
}

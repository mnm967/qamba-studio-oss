// The takes strip: a persistent panel under the stage showing every take of
// the selected block. Hovering a take thumbnail raises the floating video
// preview — the popover moved here from the timeline clips, where it was the
// primary affordance; on the timeline a click now just selects.
import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, FolderOpen, Loader2, Plus, RefreshCw, Scissors, Upload, X } from "lucide-react";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useTimelineStore } from "../../stores/useTimelineStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { supabase } from "../../lib/supabase";
import { assetUrl } from "../../lib/db/assets";
import { addTakeToBlock, uploadAndAddTake } from "../../lib/db/director";
import { loadClipJobs, retryJob, type ClipJob } from "../../lib/db/jobs";
import { blockKind, blockLabel } from "../../lib/blockKind";
import JobPreview from "./JobPreview";
import type { Asset, BlockTake, Clip, GenerationBlock } from "../../lib/db/types";

interface Hover { id: string; rect: DOMRect; assetId: string; label: string }

/** Hide the strip and hand its height back to the stage. The way BACK is the
 *  clapperboard toggle in the stage tools (Workspace), which is only offered
 *  while a clip is selected — the same shape as the inspector's X and its
 *  reopen button, rather than a second kind of affordance to learn. */
function CloseTakes() {
  const ws = useWorkspaceStore();
  return (
    <button className="ws-icobtn ws-takes-close" title="Hide takes — the clapperboard in the stage tools brings it back"
            aria-label="Hide takes" onClick={() => ws.set("takesOpen", false)}>
      <X size={14} />
    </button>
  );
}

/**
 * What the strip shows for a clip with NO BLOCK — which every clip the
 * timeline's own generate actions make is: extend, chain and add-after each
 * park an extracted still on the lane and aim a `clip_gen` at it by
 * `payload.target.clip_id`, and none of that involves a `generation_blocks`
 * row. So for the whole of a render the panel said "imported media, no
 * generation takes" over a held picture — true of the row, and the opposite of
 * what was happening.
 *
 * Three states worth distinguishing, and the third is the one that had no
 * surface at all: in flight (with the live sampler frame, the same one the
 * queue popover shows), FAILED — a chain that dies otherwise leaves a still on
 * the lane forever with nothing to say why — and genuinely-just-media.
 *
 * The finished state deliberately has no row here: `_attach_to_clip` repoints
 * the clip before it marks the job done, so the strip is already looking at
 * the take.
 */
function ClipRenders({ clip }: { clip: Clip }) {
  const tl = useTimelineStore();
  const [retrying, setRetrying] = useState(false);
  const projectId = tl.assets.get(clip.asset_id)?.project_id ?? null;

  const { data: jobs, reload } = useLiveQuery(
    async () => loadClipJobs([clip.id], projectId),
    ["jobs"], [clip.id, projectId]
  );

  const live = (jobs ?? []).filter((j) => j.status === "queued" || j.status === "running");
  // Only the newest failure: a retried chain would otherwise stack a row per
  // attempt on a 124px strip.
  const failed = (jobs ?? []).find((j) => j.status === "error") ?? null;

  const retry = async (j: ClipJob) => {
    setRetrying(true);
    try { await retryJob(j.id); reload(); }
    catch (err) { console.error("Retry failed", err); }
    finally { setRetrying(false); }
  };

  if (!live.length && !failed) {
    return (
      <div className="ws-takesbar ns-l2">
        <div className="ws-empty" style={{ margin: 0, border: "none", background: "none" }}>
          {`${clip.label ?? "Clip"} — imported media, no generation takes. `
            + "Right-click it on the lane → Save as new block to give it takes."}
        </div>
        <span style={{ flex: 1 }} />
        <CloseTakes />
      </div>
    );
  }

  return (
    <div className="ws-takesbar ns-l2">
      <div className="ws-takes-main">
        <div className="ws-takes-head">
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{clip.label ?? "Clip"}</span>
          {live.length > 0 && (
            <span className="mono" style={{ fontSize: 11.5, color: "#e8c268", display: "flex", alignItems: "center", gap: 5 }}>
              <Loader2 size={11} className="ns-spin" />rendering
            </span>
          )}
          <span className="mono" style={{ fontSize: 12, color: "#5e6678" }}>
            · the clip is holding a still until it lands
          </span>
          <span style={{ flex: 1 }} />
          <CloseTakes />
        </div>
        <div className="ws-takes-row ns-scroll">
          {live.map((j) => (
            <div key={j.id} className="ws-take ws-take-live"
                 title={j.progress_note ?? (j.status === "queued" ? "Waiting for a worker" : "Rendering")}>
              <span className="th">
                <Loader2 size={16} className="ns-spin" style={{ color: "#e8c268" }} />
                <JobPreview job={j} />
              </span>
              <span className="lbl" style={{ color: "#e8c268" }}>
                {j.cancel_requested ? "canceling…"
                  : j.status === "queued" ? "queued"
                  : `${Math.round((j.progress || 0) * 100)}%`}
              </span>
            </div>
          ))}
          {failed && (
            <div className="ws-take ws-take-fail" title={failed.error_msg ?? "The render failed"}>
              <span className="th">
                <AlertTriangle size={16} style={{ color: "#ff6b6b" }} />
              </span>
              <button className="lbl" style={{ background: "none", border: "none", padding: 0,
                                               color: "#ff8a8a", cursor: "pointer", font: "inherit" }}
                      disabled={retrying} onClick={() => void retry(failed)}>
                {retrying ? "retrying…" : "failed · retry"}
              </button>
            </div>
          )}
        </div>
        {failed?.error_msg && (
          <div className="ws-take-failmsg">{failed.error_msg}</div>
        )}
      </div>
    </div>
  );
}

export default function TakesStrip({ clip }: { clip: Clip | null }) {
  const ws = useWorkspaceStore();
  const tl = useTimelineStore();
  const [hover, setHover] = useState<Hover | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const open = (h: Omit<Hover, "rect">, el: HTMLElement) => {
    if (timer.current) clearTimeout(timer.current);
    const rect = el.getBoundingClientRect();
    timer.current = setTimeout(() => setHover({ ...h, rect }), 120);
  };
  const close = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover(null), 140);
  };
  const hold = () => { if (timer.current) clearTimeout(timer.current); };

  const handleUploadFiles = async (files: FileList | File[] | null) => {
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith("video/") || f.type.startsWith("image/"));
    if (!list.length || !clip?.block_id) return;
    for (const file of list) {
      setUploadPct(0);
      try {
        await uploadAndAddTake({
          blockId: clip.block_id,
          file,
          clipId: clip.id,
          activate: true,
          onProgress: (p) => setUploadPct(p),
        });
        reload();
      } catch (err) {
        console.error("Upload take failed", err);
      } finally {
        setUploadPct(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (!clip?.block_id) return;
    const rawAssetData = e.dataTransfer.getData("application/x-qamba-asset");
    if (rawAssetData) {
      try {
        let assetId = rawAssetData;
        if (rawAssetData.startsWith("{")) {
          assetId = JSON.parse(rawAssetData).id;
        }
        if (assetId) {
          await addTakeToBlock({
            blockId: clip.block_id,
            assetId,
            activate: true,
            clipId: clip.id,
          });
          reload();
          return;
        }
      } catch (err) {
        console.error("Failed to add dropped asset as take", err);
      }
    }
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) {
      await handleUploadFiles(files);
    }
  };

  const { data, reload } = useLiveQuery(
    async () => {
      if (!clip?.block_id) return null;
      const [{ data: block }, { data: takes }] = await Promise.all([
        supabase.from("generation_blocks").select("*").eq("id", clip.block_id).single(),
        supabase.from("block_takes").select("*").eq("block_id", clip.block_id).order("created_at"),
      ]);
      if (!block) return null;
      const b = block as GenerationBlock;
      const ids = (takes ?? []).map((t) => t.asset_id);
      const { data: assets } = ids.length
        ? await supabase.from("assets").select("*").in("id", ids) : { data: [] };
      return {
        block: b,
        takes: (takes ?? []) as BlockTake[],
        assets: new Map(((assets ?? []) as Asset[]).map((a) => [a.id, a])),
      };
    },
    ["block_takes", "generation_blocks", "assets"], [clip?.block_id]
  );

  // No selection, no panel. It used to render "Select a clip…" — 116px of
  // dead column on every project open, above a player that wanted the room.
  // The parent gates on this too; returning null keeps the rule true for any
  // other mount (the dev fixture).
  if (!clip) return null;
  // A clip with no block is not necessarily media somebody imported — see
  // ClipRenders. Every hook above has already run, so this branch is safe.
  if (!clip.block_id) return <ClipRenders clip={clip} />;
  if (!data) {
    return (
      <div className="ws-takesbar ns-l2">
        <div className="ws-empty" style={{ margin: 0, border: "none", background: "none" }}>
          Loading takes…
        </div>
        <span style={{ flex: 1 }} />
        <CloseTakes />
      </div>
    );
  }

  const { block, takes } = data;

  // THE COPIES OF THIS BLOCK ON THE OPEN CUT. A block can be on a lane more
  // than once — ⌘D, a split, or dragging it from the shots rail again — and
  // the reason to put a shot down twice is to show two takes of it. Picture
  // clips only, the rule the sync and `exclusionsAfterStep` already state: a
  // detached audio half carries `block_id` too and is not a second copy of
  // the shot.
  const videoLanes = new Set(tl.tracks.filter((t) => t.kind === "video").map((t) => t.id));
  const otherCopies = tl.clips.filter(
    (c) => c.block_id === block.id && c.id !== clip.id && videoLanes.has(c.track_id));
  const many = otherCopies.length > 0;
  // What THIS clip plays, which is what the strip is about — it is shown for
  // the selected clip and reads its block off it. With no pin that is the
  // block's own take, i.e. identical to what this said before.
  const playing = clip.take_id ?? block.active_take_id;

  /** Make this the BLOCK's take: every copy that is following the block moves
   *  to it, the storyboard shows it, and a chained block anchors on it. It
   *  clears this clip's own pin, because a pin naming the take the block now
   *  uses says nothing and would quietly outlive the next change. */
  const activate = async (t: BlockTake) => {
    await supabase.from("block_takes").update({ state: "kept" }).eq("id", t.id);
    await supabase.from("generation_blocks")
      .update({ active_take_id: t.id, status: "generated" }).eq("id", block.id);
    tl.patchClip(clip.id, { asset_id: t.asset_id, take_id: null });
    reload();
  };

  /** Play this take on THIS COPY ONLY, leaving the block's own alone.
   *
   *  `take_id` is what survives the sync — repointing `asset_id` by itself
   *  lasts until the next take lands, the next re-render or the next reload,
   *  and then becomes the block's again with nothing saying so. That is the
   *  whole reason the column exists.
   *
   *  PICKING THE BLOCK'S OWN TAKE IS FOLLOWING THE BLOCK, and that is the way
   *  out of a pin — no control to add, because pinning a copy to the take the
   *  block is already on says nothing that "following it" does not, and the
   *  unpinned state is the one that keeps up when the block moves. The tile
   *  says which one that is ("· the block's"). */
  const useHere = async (t: BlockTake) => {
    await supabase.from("block_takes").update({ state: "kept" }).eq("id", t.id);
    const follows = t.id === block.active_take_id;
    tl.patchClip(clip.id, { asset_id: t.asset_id, take_id: follows ? null : t.id });
    reload();
  };


  return (
    <div className={"ws-takesbar ns-l2" + (dragOver ? " dragover" : "")}
         onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
         onDragLeave={() => setDragOver(false)}
         onDrop={handleDrop}>
      <div className="ws-takes-main">
        <div className="ws-takes-head">
          {/* Named for what it IS. "Block 9" over a chain loses the one fact
              that explains why it is 3.7s long and sits between two shots. */}
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>
            {blockLabel(blockKind(block), block.idx)}
          </span>
          <span className="mono" style={{ fontSize: 12, color: "#5e6678" }}>
            · {takes.length} take{takes.length === 1 ? "" : "s"}
          </span>
          {block.status === "generating" && (
            <span className="mono" style={{ fontSize: 11.5, color: "#e8c268", display: "flex", alignItems: "center", gap: 5 }}>
              <Loader2 size={11} className="ns-spin" />rendering
            </span>
          )}
          {dragOver && (
            <span className="mono" style={{ fontSize: 11.5, color: "#5aa2ff", marginLeft: "auto" }}>
              Drop asset or video file to add take
            </span>
          )}
          <span style={{ flex: 1 }} />
          <CloseTakes />
        </div>
        <div className="ws-takes-row ns-scroll">
          {takes.map((t, i) => {
            const a = data.assets.get(t.asset_id);
            // THE LIT TILE IS WHAT THIS CLIP PLAYS, not what the block is on.
            // The strip is shown for the selected clip and reads its block off
            // it, so the clip is what it is about — and with no pin the two
            // are the same take, which is every clip that exists today.
            const here = t.id === playing;
            const blockTake = t.id === block.active_take_id;
            return (
              <button key={t.id} className={"ws-take" + (here ? " on" : "") + (t.state === "rejected" ? " rej" : "")}
                      onPointerEnter={(e) => a && open({ id: t.id, assetId: a.id, label: `Take ${i + 1}` }, e.currentTarget)}
                      onPointerLeave={close}
                      // With ONE copy on the cut, picking a take IS setting
                      // the block's — they cannot differ, and activating is
                      // the one that also moves the storyboard and a chained
                      // block's anchor. With several, the click acts on the
                      // copy this strip is showing.
                      onClick={() => { if (here) return; void (many ? useHere(t) : activate(t)); }}
                      onDoubleClick={() => ws.openModal({ kind: "takes", blockId: block.id })}
                      title={here
                        ? (clip.take_id ? "This copy plays this take — double-click to assemble"
                                        : "Active take — double-click to assemble")
                        : many ? "Click to play this take on THIS copy — the other copies keep "
                                 + "the block's. Double-click to assemble"
                               : "Click to use this take, double-click to assemble"}>
                <span className="th">
                  {a && (
                    <video src={assetUrl(a) ?? undefined} muted preload="metadata" playsInline
                           onLoadedMetadata={(e) => {
                             const v = e.currentTarget;
                             if (v.duration) v.currentTime = v.duration * 0.35;
                           }} />
                  )}
                  {here && <span className="badge"><Check size={10} /></span>}
                </span>
                <span className="lbl">
                  Take {i + 1}
                  {t.kind !== "master" ? ` · ${t.kind}` : ""}
                  {t.state === "rejected" ? " · rejected" : ""}
                  {/* Where the block's own take has gone, once this copy has
                      stopped following it — otherwise the lit tile is the only
                      thing on screen and "active take" quietly means two
                      different things on two copies of one block. */}
                  {blockTake && !here ? " · the block's" : ""}
                </span>
              </button>
            );
          })}
          {uploadPct != null && (
            <div className="ws-take" style={{ opacity: 0.85 }}>
              <span className="th" style={{ display: "grid", placeItems: "center", border: "1px dashed #5aa2ff", background: "rgba(90,162,255,.08)" }}>
                <Loader2 size={16} className="ns-spin" style={{ color: "#5aa2ff" }} />
              </span>
              <span className="lbl" style={{ color: "#5aa2ff" }}>
                {Math.round(uploadPct * 100)}%
              </span>
            </div>
          )}
          {takes.length > 1 && (
            <button className="ws-take add" onClick={() => ws.openModal({ kind: "takes", blockId: block.id })}
                    title="Compare these takes, or cut the best parts of each into one">
              <span className="th" style={{ borderColor: "rgba(90,162,255,.4)", color: "#8fc2ff" }}>
                <Scissors size={15} /> Assemble
              </span>
              <span className="lbl">Best of {takes.length}</span>
            </button>
          )}
          <button className="ws-take add" onClick={() => ws.openModal({ kind: "prompt", blockId: block.id })}
                  title="Queue another AI take with notes">
            <span className="th"><Plus size={15} /> Retake</span>
            <span className="lbl">AI render</span>
          </button>
          <button className="ws-take add" onClick={() => ws.openModal({ kind: "pickTake", blockId: block.id, clipId: clip.id })}
                  title="Pick or upload a take from your library">
            <span className="th"><FolderOpen size={15} /> Library</span>
            <span className="lbl">From library</span>
          </button>
        </div>
      </div>

      {hover && createPortal(
        (() => {
          const W = 300;
          const a = data.assets.get(hover.assetId);
          const left = Math.max(8, Math.min(window.innerWidth - W - 8,
            hover.rect.left + hover.rect.width / 2 - W / 2));
          const above = hover.rect.top > 250;
          return (
            <div className="ws-hover ns-l2 ns-pop"
                 onPointerEnter={hold} onPointerLeave={close}
                 style={{
                   position: "fixed", left, width: W,
                   ...(above ? { bottom: window.innerHeight - hover.rect.top + 10 }
                             : { top: hover.rect.bottom + 10 }),
                 }}>
              <div style={{ position: "relative", aspectRatio: "16/9", background: "#000" }}
                   onPointerMove={(e) => {
                     const v = e.currentTarget.querySelector("video");
                     const bar = e.currentTarget.querySelector<HTMLElement>("[data-bar]");
                     if (!v?.duration) return;
                     const r = e.currentTarget.getBoundingClientRect();
                     const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
                     v.currentTime = f * v.duration;
                     if (bar) bar.style.width = `${f * 100}%`;
                   }}>
                <video src={assetUrl(a) ?? undefined} muted preload="metadata" playsInline
                       onLoadedMetadata={(e) => {
                         const v = e.currentTarget;
                         if (v.duration) v.currentTime = v.duration * 0.35;
                       }}
                       style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 3, background: "rgba(255,255,255,.16)" }}>
                  <span data-bar style={{ display: "block", height: "100%", width: "35%", background: "#eaeef6" }} />
                </div>
                <span className="mono" style={{ position: "absolute", left: 9, top: 9, padding: "4px 8px", borderRadius: 10,
                                                background: "rgba(7,9,14,.72)", backdropFilter: "blur(12px)",
                                                fontSize: 10.5, fontWeight: 600, color: "#eaeef6" }}>
                  {hover.label} · scrub to preview
                </span>
              </div>
              <div style={{ padding: 11, display: "flex", gap: 7 }}>
                <button style={{ flex: 1, height: 34, borderRadius: 14, border: "1px solid rgba(90,162,255,.45)",
                                 background: "rgba(90,162,255,.11)", color: "#5aa2ff",
                                 fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                        onClick={() => ws.openModal({ kind: "takes", blockId: block.id })}>
                  {takes.length > 1 ? `Assemble ${takes.length} takes` : "Open full size"}
                </button>
                <button title="Retake with notes"
                        style={{ width: 34, height: 34, borderRadius: 14, border: "1px solid rgba(255,255,255,.08)",
                                 background: "rgba(255,255,255,.04)", color: "#9aa4b6",
                                 display: "grid", placeItems: "center", cursor: "pointer" }}
                        onClick={() => ws.openModal({ kind: "prompt", blockId: block.id })}>
                  <RefreshCw size={14} />
                </button>
              </div>
            </div>
          );
        })(),
        document.body
      )}
    </div>
  );
}

import React, { useEffect, useRef, useState } from "react";
import { supabase, mediaUrl } from "../../lib/supabase";
import { useTimelineStore } from "../../stores/useTimelineStore";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { queueBlockRender } from "../../lib/db/jobs";
import { uploadAndAddTake } from "../../lib/db/director";
import type { Asset, BlockTake, Clip } from "../../lib/db/types";

/** Browse a block's takes from its timeline clip: play each, keep one
 * (repoints the clip + block), queue a retake. */
export default function TakesPopover({
  clip,
  x,
  y,
  onClose,
}: {
  clip: Clip;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const ws = useWorkspaceStore();
  const [takes, setTakes] = useState<(BlockTake & { asset?: Asset })[]>([]);
  const [activeTakeId, setActiveTakeId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const patchClip = useTimelineStore((s) => s.patchClip);

  const fetchTakes = async () => {
    if (!clip.block_id) return;
    const { data: block } = await supabase
      .from("generation_blocks").select("active_take_id").eq("id", clip.block_id).single();
    setActiveTakeId(block?.active_take_id ?? null);
    const { data: rows } = await supabase
      .from("block_takes").select("*").eq("block_id", clip.block_id)
      .order("created_at", { ascending: false });
    const ids = (rows ?? []).map((t) => t.asset_id);
    const { data: assets } = ids.length
      ? await supabase.from("assets").select("*").in("id", ids)
      : { data: [] };
    const amap = new Map((assets ?? []).map((a) => [a.id, a as Asset]));
    setTakes((rows ?? []).map((t) => ({ ...(t as BlockTake), asset: amap.get(t.asset_id) })));
  };

  useEffect(() => {
    fetchTakes().catch(console.error);
  }, [clip.block_id]);

  const handleUpload = async (files: FileList | File[] | null) => {
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith("video/") || f.type.startsWith("image/"));
    if (!list.length || !clip.block_id) return;
    setUploading(true);
    try {
      for (const file of list) {
        await uploadAndAddTake({
          blockId: clip.block_id,
          file,
          clipId: clip.id,
          activate: true,
        });
      }
      await fetchTakes();
    } catch (err) {
      console.error("Upload take failed", err);
    } finally {
      setUploading(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  };

  const keep = async (take: BlockTake) => {
    await supabase.from("block_takes").update({ state: "kept" }).eq("id", take.id);
    await supabase.from("generation_blocks")
      .update({ active_take_id: take.id }).eq("id", clip.block_id);
    patchClip(clip.id, { asset_id: take.asset_id });
    setActiveTakeId(take.id);
  };

  /** Roll the block again. `recompute_refs` for the storyboard retake's
   *  reason, one surface over: the plan stored on the row is the one the
   *  episode was PLANNED with, so without it a retake restages the sheets and
   *  panels that have since been redrawn — silently, since the render still
   *  succeeds. Two buttons both called "retake" disagreeing about that is
   *  worse than either answer. */
  const retake = async () => {
    if (!clip.block_id) return;
    await queueBlockRender(clip.block_id, {
      payload: { take_of: activeTakeId, auto_activate: false, recompute_refs: true },
    });
    onClose();
  };

  if (!clip.block_id) return null;
  return (
    <div
      className="takespop"
      style={{ left: Math.min(x, window.innerWidth - 320), top: Math.min(y, window.innerHeight - 400) }}
      onPointerLeave={onClose}
    >
      <div className="tk-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        <span>Takes · {clip.label ?? "block"}</span>
        <div style={{ display: "flex", gap: 4 }}>
          {takes.length > 1 && (
            <button className="tk-btn keep"
                    title="Compare these takes, or cut the best parts of each into one"
                    onClick={() => { ws.openModal({ kind: "takes", blockId: clip.block_id! }); onClose(); }}>
              Assemble
            </button>
          )}
          <button className="tk-btn" onClick={() => { ws.openModal({ kind: "pickTake", blockId: clip.block_id!, clipId: clip.id }); onClose(); }}>
            + Library
          </button>
          <button className="tk-btn" onClick={retake}>
            + AI
          </button>
        </div>
      </div>
      {takes.length === 0 && <div className="tk-info">No takes yet.</div>}
      {takes.map((t) => (
        <div key={t.id} className={"tk-row" + (t.id === activeTakeId ? " active" : "")}>
          {t.asset && <video src={mediaUrl(t.asset.b2_key) ?? undefined} muted loop autoPlay playsInline />}
          <div className="tk-info">
            <div>{t.kind}{t.id === activeTakeId ? " · active" : ""}</div>
            <div className="mono">{t.asset?.duration_ms ?? "?"}ms</div>
          </div>
          <div className="tk-actions">
            {t.id !== activeTakeId && (
              <button className="tk-btn keep" onClick={() => keep(t)}>
                Use
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

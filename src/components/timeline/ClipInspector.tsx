import React, { useState } from "react";
import { X, FlipHorizontal2, FlipVertical2, Crop, Gauge, Rewind, Snowflake, Wand2, Layers } from "lucide-react";
import { useTimelineStore } from "../../stores/useTimelineStore";
import { enqueueJob } from "../../lib/db/jobs";
import VideoEditModal from "./VideoEditModal";
import { freezeSourceMs } from "../../lib/clipFrames";
import type { Clip, ClipOp } from "../../lib/db/types";

const OP_LABEL = (op: ClipOp): string => {
  switch (op.op) {
    case "flip": return `flip ${op.dir}`;
    case "transform": return `transform r${op.rotate ?? 0} s${op.scale ?? 1}`;
    case "crop": return `crop ${op.w}×${op.h}@${op.x},${op.y}`;
    case "speed": return `speed ×${op.rate}`;
    case "reverse": return "reverse";
    case "freeze": return `freeze ${op.dur_ms}ms @${op.at_ms}ms of source`;
    default: return JSON.stringify(op);
  }
};

/** Selected-clip panel: ops, transition, gain, AI actions (retake/patch/edit
 * via jobs), post chains (M7 wires the post_* kinds). */
export default function ClipInspector({ clip }: { clip: Clip }) {
  const { addOp, removeOp, patchClip, select, removeClip, assets } = useTimelineStore();
  const [speed, setSpeed] = useState("1.5");
  const [editOpen, setEditOpen] = useState(false);
  const asset = assets.get(clip.asset_id);

  const post = async (kind: string, params: Record<string, unknown> = {}) => {
    await enqueueJob({
      kind,
      lane: "gpu",
      priority: 70,
      payload: { asset_id: clip.asset_id, clip_id: clip.id, ...params },
    });
  };

  return (
    <aside className="tl-inspector">
      <button style={{ float: "right", color: "var(--mid)" }} onClick={() => select(null)}>
        <X size={16} />
      </button>
      <h3>{clip.label ?? "Clip"}</h3>
      <div className="insp-sub">
        {clip.duration_ms}ms · in {clip.in_ms}ms{clip.out_ms != null ? ` · out ${clip.out_ms}ms` : ""}
        {asset ? ` · ${asset.width}×${asset.height}` : ""}
      </div>

      <div className="insp-sec">
        <span className="label">Alterations</span>
        <div className="insp-row">
          <button className="insp-chip" onClick={() => addOp(clip.id, { op: "flip", dir: "h" })}>
            <FlipHorizontal2 size={12} /> flip H
          </button>
          <button className="insp-chip" onClick={() => addOp(clip.id, { op: "flip", dir: "v" })}>
            <FlipVertical2 size={12} /> flip V
          </button>
          <button className="insp-chip" onClick={() => addOp(clip.id, { op: "reverse" })}>
            <Rewind size={12} /> reverse
          </button>
          <button
            className="insp-chip"
            // The clip's own midpoint, converted to the SOURCE offset the
            // renderer reads — a timeline width is not one at any rate but 1x.
            onClick={() => addOp(clip.id, {
              op: "freeze", at_ms: freezeSourceMs(clip, clip.duration_ms / 2), dur_ms: 1000,
            })}
          >
            <Snowflake size={12} /> freeze 1s
          </button>
          <button
            className="insp-chip"
            onClick={() => {
              const a = assets.get(clip.asset_id);
              const w = a?.width ?? 1280;
              const h = a?.height ?? 720;
              addOp(clip.id, {
                op: "crop",
                x: Math.round(w * 0.1), y: Math.round(h * 0.1),
                w: Math.round(w * 0.8), h: Math.round(h * 0.8),
              });
            }}
          >
            <Crop size={12} /> crop 80%
          </button>
          <button className="insp-chip" onClick={() => addOp(clip.id, { op: "speed", rate: parseFloat(speed) || 1.5 })}>
            <Gauge size={12} /> speed
          </button>
          <input
            className="insp-input"
            style={{ width: 64, marginTop: 0 }}
            value={speed}
            onChange={(e) => setSpeed(e.target.value)}
            title="speed rate"
          />
        </div>
        {(clip.ops ?? []).length > 0 && (
          <div className="insp-oplist">
            {(clip.ops ?? []).map((op, i) => (
              <div key={i} className="insp-op">
                {OP_LABEL(op)}
                <button onClick={() => removeOp(clip.id, i)}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="insp-sec">
        <span className="label">Transition in</span>
        <div className="insp-row">
          {[null, 500, 1000].map((d) => (
            <button
              key={String(d)}
              className={
                "insp-chip" +
                ((d === null && !clip.transition_in) ||
                (clip.transition_in?.type === "xfade" && clip.transition_in?.dur_ms === d)
                  ? " on"
                  : "")
              }
              onClick={() =>
                patchClip(clip.id, {
                  transition_in: d === null ? null : { type: "xfade", dur_ms: d, style: "fade" },
                })
              }
            >
              {d === null ? "cut" : `xfade ${d}ms`}
            </button>
          ))}
          <button
            className={"insp-chip" + (clip.transition_in?.type === "generated" ? " on" : "")}
            title="Generate an AI transition into this clip (FLF bridge)"
            onClick={async () => {
              const clips = useTimelineStore.getState().clips
                .filter((c) => c.track_id === clip.track_id)
                .sort((a, b) => a.t_start_ms - b.t_start_ms);
              const prev = [...clips].reverse().find((c) => c.t_start_ms < clip.t_start_ms);
              if (!prev) return;
              await enqueueJob({
                kind: "transition_gen",
                lane: "gpu",
                priority: 10,
                payload: {
                  from_asset_id: prev.asset_id,
                  to_asset_id: clip.asset_id,
                  to_at_ms: clip.in_ms ?? 0,
                  dur_ms: 1000,
                },
              });
            }}
          >
            <Wand2 size={12} /> AI bridge
          </button>
        </div>
      </div>

      <div className="insp-sec">
        <span className="label">AI edit (H3 video reference)</span>
        <div className="insp-row">
          <button className="insp-chip" disabled={!asset}
                  title={asset ? "Edit this clip with the source video as the model's input"
                               : "No media resolved for this clip yet"}
                  onClick={() => setEditOpen(true)}>
            <Wand2 size={12} /> open edit mode
          </button>
        </div>
      </div>
      {editOpen && asset && (
        <VideoEditModal
          source={asset}
          blockId={clip.block_id ?? null}
          projectId={(asset as { project_id?: string | null }).project_id ?? null}
          onClose={() => setEditOpen(false)}
        />
      )}

      <div className="insp-sec">
        <span className="label">Post-processing</span>
        <div className="insp-row">
          <button className="insp-chip" onClick={() => post("post_upscale")}>
            <Layers size={12} /> restore/upscale
          </button>
          <button className="insp-chip" onClick={() => post("post_interpolate", { target_fps: 48 })}>
            interpolate 48fps
          </button>
          <button className="insp-chip" onClick={() => post("post_facefix")}>
            face detail
          </button>
          <button className="insp-chip" onClick={() => post("post_grain_color")}>
            de-AI grain
          </button>
        </div>
      </div>

      <div className="insp-sec">
        <span className="label">Danger</span>
        <div className="insp-row">
          <button className="insp-chip danger" onClick={() => removeClip(clip.id, false)}>
            delete
          </button>
          <button className="insp-chip danger" onClick={() => removeClip(clip.id, true)}>
            ripple delete
          </button>
        </div>
      </div>
    </aside>
  );
}

import React, { useEffect, useMemo } from "react";
import V2Shell from "../design/V2Shell";
import Timeline from "../components/timeline/Timeline";
import PreviewPlayer from "../components/timeline/PreviewPlayer";
import ClipInspector from "../components/timeline/ClipInspector";
import { useTimelineStore } from "../stores/useTimelineStore";
import type { Asset, Clip, Timeline as TL, Track } from "../lib/db/types";
// Both, and the second one is not optional: `.pv-layer` — the rule that
// makes a preview layer fill the stage — lives in workspace.css, so
// without it this page renders the player as a 0x1px sliver and cannot
// verify the one thing it exists to verify.
import "../styles/timeline.css";
import "../styles/workspace.css";

// Dev-only fixture page: exercises the editor with local state and no
// network. Never linked in navigation; the route exists only under Vite dev.
const now = new Date().toISOString();
const tl: TL = { id: "demo-tl", episode_id: "demo-ep", name: "Demo", fps: 24,
  width: 1280, height: 720, render_asset_id: null, render_stale: true };
const tracks: Track[] = [
  { id: "v1", timeline_id: tl.id, kind: "video", idx: 0, name: "V1", muted: false, solo: false, locked: false, gain_db: 0, duck_under_track_id: null, automation: [], audio_fx: [] },
  { id: "a1", timeline_id: tl.id, kind: "audio", idx: 0, name: "A1", muted: false, solo: false, locked: false, gain_db: 0, duck_under_track_id: null, automation: [], audio_fx: [] },
];
const mkAsset = (id: string, kind: Asset["kind"], dur: number, peaks = false): Asset => ({
  id, project_id: null, kind, b2_key: `demo/${id}.mp4`, content_type: null, bytes: null,
  width: 1280, height: 720, duration_ms: dur, fps: 24, origin: "generated",
  source_job_id: null, tags: [],
  meta: peaks ? { peaks: Array.from({ length: 320 }, (_, i) => Math.abs(Math.sin(i / 7)) * (0.4 + 0.6 * Math.abs(Math.sin(i / 41)))) } : {},
  created_at: now,
});
// A STILL on a video lane, which is a real case and used to be an invisible
// failure: every generate action in the timeline (extend, chain, add-after)
// puts the extracted start frame on the lane while the GPU works, and a
// <video> can never finish loading a JPEG — readyState 0 forever, so the stage
// sat black under "buffering…" until the render landed. It is an <img> layer
// now (lib/assetKind.isStill), holding the frame for the clip's window.
// `mediaUrl` passes an absolute URL through, so the fixture can point at
// something the dev server actually serves and stay network-free.
const still = mkAsset("frm", "image", 0);
still.b2_key = `${location.origin}/favicon.png`;
const assets = new Map<string, Asset>([
  ["as1", mkAsset("as1", "video", 12000)],
  ["as2", mkAsset("as2", "video", 12000)],
  ["as3", mkAsset("as3", "video", 15000)],
  ["mus", mkAsset("mus", "audio", 30000, true)],
  ["frm", still],
]);
const clips: Clip[] = [
  { id: "c1", track_id: "v1", asset_id: "as1", block_id: "b1", take_id: null, t_start_ms: 0, duration_ms: 12000,
    in_ms: 0, out_ms: 12000, ops: [], transition_in: null, post: null, linked_clip_id: null, audio_detached: false, audio_fx: [], gain_db: 0, label: "Block 1", updated_at: now },
  { id: "c2", track_id: "v1", asset_id: "as2", block_id: "b2", take_id: null, t_start_ms: 12000, duration_ms: 12000,
    in_ms: 0, out_ms: 12000, ops: [{ op: "speed", rate: 1.25 }], transition_in: { type: "xfade", dur_ms: 500, style: "fade" },
    post: null, linked_clip_id: null, audio_detached: false, audio_fx: [], gain_db: 0, label: "Block 2", updated_at: now },
  { id: "c3", track_id: "v1", asset_id: "as3", block_id: null, take_id: null, t_start_ms: 24000, duration_ms: 6000,
    in_ms: 2000, out_ms: 8000, ops: [{ op: "flip", dir: "h" }], transition_in: null, post: null, linked_clip_id: null, audio_detached: false, audio_fx: [], gain_db: 0,
    label: "B-roll", updated_at: now },
  { id: "c5", track_id: "v1", asset_id: "frm", block_id: null, take_id: null, t_start_ms: 30000, duration_ms: 4000,
    in_ms: 0, out_ms: null, ops: [], transition_in: null, post: null, linked_clip_id: null, audio_detached: false, audio_fx: [], gain_db: 0,
    label: "Extended Block (pending)", updated_at: now },
  { id: "c4", track_id: "a1", asset_id: "mus", block_id: null, take_id: null, t_start_ms: 0, duration_ms: 30000,
    in_ms: 0, out_ms: 30000, ops: [], transition_in: null, post: null, linked_clip_id: null, audio_detached: false, audio_fx: [], gain_db: -3, label: "Master track", updated_at: now },
];

export default function TimelineDemoPage() {
  const store = useTimelineStore();
  useEffect(() => {
    useTimelineStore.setState({
      timeline: tl, tracks, clips, assets,
      beatsMs: Array.from({ length: 60 }, (_, i) => i * 500),
      selectedClipId: "c2",
    });
  }, []);
  const selected = useMemo(
    () => store.clips.find((c) => c.id === store.selectedClipId) ?? null,
    [store.clips, store.selectedClipId]
  );
  return (
    <V2Shell title="Timeline demo" eyebrow="Dev fixture" wide>
      <div className="tledit">
        <PreviewPlayer />
        <Timeline />
      </div>
      {selected && <ClipInspector clip={selected} />}
    </V2Shell>
  );
}

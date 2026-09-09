// DEV-only: renders the workspace timeline chrome against in-memory fixtures
// (with real local media in /public/demo) so playback + layout can be
// verified without network access. Never routed in prod.
import React, { useEffect, useState } from "react";
import { Camera, Grid3x3, Maximize2, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useTimelineStore } from "../stores/useTimelineStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import WsTimeline from "../components/shell/WsTimeline";
import TakesStrip from "../components/shell/TakesStrip";
import InspectorRail from "../components/shell/InspectorRail";
import IconRail from "../components/shell/IconRail";
import PreviewPlayer from "../components/timeline/PreviewPlayer";
import CameraPicker from "../components/modals/CameraPicker";
import { useTimelineKeys } from "../hooks/useTimelineKeys";
import { frameAtPlayhead } from "../lib/playheadFrame";
import { captureVideoFrame } from "../lib/frameExtractor";
import { rasterPlan } from "../lib/clipRaster";
import type { Asset, Clip, Timeline as TL, Track } from "../lib/db/types";
import "../styles/workspace.css";
// The block context menu lives here. Without it the harness renders the menu
// as correct markup with no design at all — which reads as a broken menu.
import "../styles/timeline.css";

const now = new Date().toISOString();
const tl: TL = { id: "d", episode_id: "e", name: "Main", fps: 24, width: 1280, height: 704,
  render_asset_id: null, render_stale: true };
const tracks: Track[] = [
  { id: "v2", timeline_id: "d", kind: "video", idx: 1, name: "V2", muted: false, solo: false, locked: false, gain_db: 0, duck_under_track_id: null, automation: [], audio_fx: [] },
  { id: "v1", timeline_id: "d", kind: "video", idx: 0, name: "V1", muted: false, solo: false, locked: false, gain_db: 0, duck_under_track_id: null, automation: [], audio_fx: [] },
  { id: "a1", timeline_id: "d", kind: "audio", idx: 0, name: "A1", muted: true, solo: false, locked: false, gain_db: 0, duck_under_track_id: null, automation: [], audio_fx: [] },
  { id: "a2", timeline_id: "d", kind: "audio", idx: 1, name: "A2", muted: false, solo: false, locked: false, gain_db: 0, duck_under_track_id: null, automation: [], audio_fx: [] },
  { id: "a3", timeline_id: "d", kind: "audio", idx: 2, name: "A3", muted: false, solo: false, locked: false, gain_db: 0, duck_under_track_id: null, automation: [], audio_fx: [] },
];
// b2_key is an absolute URL here: mediaUrl() passes those through untouched,
// so the fixture drives the real assetUrl()/mediaUrl() path everywhere.
const mk = (id: string, dur: number, url: string, peaks = false): Asset => ({
  id, project_id: null, kind: peaks ? "audio" : "video", b2_key: url,
  content_type: null, bytes: null, width: 640, height: 352, duration_ms: dur, fps: 24,
  origin: "generated", source_job_id: null, tags: [],
  meta: peaks ? { peaks: Array.from({ length: 120 }, (_, i) => Math.abs(Math.sin(i / 6)) * 0.8 + 0.1) } : {},
  created_at: now,
});
const LABELS = ["rooftop wide", "rue drops in", "ward corridor", "hanan close"];
const clips: Clip[] = LABELS.map((label, i) => ({
  id: `b${i}`, track_id: "v1", asset_id: `as${i}`, block_id: `blk${i}`, take_id: null,
  t_start_ms: i * 6000, duration_ms: 6000, in_ms: 0, out_ms: 6000,
  ops: i === 2 ? [{ op: "flip", dir: "h" } as never] : [],
  transition_in: i === 3 ? { type: "xfade", dur_ms: 800, style: "fade" } : null,
  post: null, linked_clip_id: null, audio_detached: false, audio_fx: [], gain_db: 0, label, updated_at: now,
}));
clips.push({ id: "mus", track_id: "a1", asset_id: "mus", block_id: null, take_id: null, t_start_ms: 0,
  duration_ms: 24000, in_ms: 0, out_ms: 24000, ops: [], transition_in: null, post: null, linked_clip_id: null, audio_detached: false, audio_fx: [], gain_db: 0,
  label: "shattered_skies", updated_at: now });
// ?xorigin=1 serves the same media from a second origin that sends NO
// Access-Control-Allow-Origin — exactly how the B2 CDN behaves — so the
// player can be tested against real-world CORS conditions.
const BASE = typeof location !== "undefined" && new URLSearchParams(location.search).get("xorigin")
  ? "http://localhost:8899" : `${location.origin}/demo`;
const assets = new Map<string, Asset>([
  ...LABELS.map((_, i) => [`as${i}`, mk(`as${i}`, 6000, `${BASE}/b${i}.webm`)] as [string, Asset]),
  ["mus", mk("mus", 30000, `${BASE}/music.webm`, true)],
]);

export default function WorkspaceDemo() {
  const playing = usePlaybackStore((s) => s.playing);
  const toggle = usePlaybackStore((s) => s.toggle);
  const seek = usePlaybackStore((s) => s.seek);
  const onTick = usePlaybackStore((s) => s.onTick);
  const [tc, setTc] = useState(0);
  const [camOpen, setCamOpen] = useState(false);
  // The grab-frame button's own result, shown beside the stage so a
  // SCREENSHOT can answer the only question that matters about this feature:
  // does the saved picture match the frame on the stage? Nothing about that is
  // observable from an assertion on state — a grab of the wrong instant, of
  // the wrong lane, or with the clip's `flip h` dropped all produce a
  // perfectly good JPEG. Clip b2 carries a flip for exactly this reason.
  const [grab, setGrab] = useState<{ url: string; note: string } | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  // The LIVE clip, not the fixture row. `clips` here is a module constant, so
  // finding the selection in it hands the inspector a clip frozen at page
  // load — every edit made through the store (a trim, an effect chain) was
  // invisible in the panel that made it, which reads as the panel being broken.
  const sel = useTimelineStore((s) => s.clips.find((c) => c.id === s.selectedClipId) ?? null);
  const selTrack = useTimelineStore((s) => s.tracks.find((t) => t.id === s.selectedTrackId) ?? null);
  useTimelineKeys();
  useEffect(() => onTick((ms) => setTc(ms)), [onTick]);
  useEffect(() => {
    useTimelineStore.setState({
      timeline: tl, tracks, clips, assets,
      beatsMs: Array.from({ length: 60 }, (_, i) => i * 432),
      // BOTH selection fields. They are two halves of one thing — a primary
      // with an empty set is a clip the inspector is about and a group drag
      // cannot see — and this raw setState is the one place in the app that
      // does not go through `selectionOf`.
      selectedClipId: "b1",
      selectedClipIds: ["b1"],
    });
  }, []);
  // The real path's decision and the real path's capture — only the upload and
  // the `assets` row are left off. See Workspace.tsx's `grabFrame`.
  const grabFrame = () => {
    const ms = usePlaybackStore.getState().nowMs();
    const st = useTimelineStore.getState();
    const hit = frameAtPlayhead(st.tracks, st.clips, ms);
    if (!hit) { setGrab({ url: "", note: `nothing on the video lanes at ${(ms / 1000).toFixed(2)}s` }); return; }
    const asset = st.assets.get(hit.clip.asset_id);
    if (!asset) return;
    setGrabbing(true);
    void captureVideoFrame(asset.b2_key, hit.srcMs / 1000, 0.02, rasterPlan(hit.clip, asset))
      .then(
        (shot) => setGrab({
          url: URL.createObjectURL(shot.blob),
          // WHERE IT LANDED, not what was asked for — the whole lesson of
          // frameExtractor.ts, and the number a screenshot has to carry for
          // the picture beside it to mean anything.
          note: `${hit.clip.label} @ ${(ms / 1000).toFixed(2)}s cut `
              + `→ ${shot.atSec.toFixed(2)}s src`
              + (hit.midTransition ? " · mid-xfade" : ""),
        }),
        (err) => setGrab({ url: "", note: `failed: ${(err as Error)?.message ?? err}` }))
      .finally(() => setGrabbing(false));
  };

  return (
    <div className="ws">
      <header className="ws-top">
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span className="ws-mark"><img src="/logo/mark.png" alt="" /></span><span className="ws-brand">QAMBA</span>
        </div>
        <span className="ws-vdiv" />
        <span className="ws-mlabel">playback + layout fixture</span>
        <span style={{ flex: 1 }} />
        <button className="ws-btn-purple" data-cam onClick={() => setCamOpen(true)}>Camera picker</button>
      </header>
      <div className="ws-body">
        <IconRail />
        <main className="ws-main">
          <div className="ws-viewer">
            <div className="ws-stagecol">
            <div className="ws-stagewrap">
              <div className="ws-stage">
                <PreviewPlayer bare />
              </div>
            </div>
            <div className="ws-ctlbar ns-hud">
              <div className="ws-ctl-transport">
                <button className="ws-round lg" data-t="start" onClick={() => seek(0)}><SkipBack size={16} /></button>
                <button className="ws-play" data-t="play" onClick={toggle}>
                  {playing ? <Pause size={18} /> : <Play size={18} />}
                </button>
                <button className="ws-round lg" onClick={() => seek(24000)}><SkipForward size={16} /></button>
                <span className="ws-tc" data-t="tc">{(tc / 1000).toFixed(1)}</span>
              </div>
              <span style={{ flex: 1 }} />
              <div className="ws-stage-tools">
                <button className="ws-round"><Grid3x3 size={15} /></button>
                {/* The real button SAVES to the library; this one stops at the
                    capture. A harness that uploads and registers an asset by
                    being opened is what /ui/blockaudio's no-queue rule
                    forbids — and the capture is the half worth looking at,
                    since the upload is the same call every other extract in
                    the app already makes. */}
                <button className="ws-round" data-t="grab"
                        disabled={playing || grabbing}
                        title={playing
                          ? "Pause to grab the frame you're looking at"
                          : "Grab this frame (harness: captures, does not upload)"}
                        onClick={grabFrame}>
                  <Camera size={15} />
                </button>
                <button className="ws-round"><Maximize2 size={15} /></button>
              </div>
            </div>
            {grab && (
              <div data-t="grabbed" style={{ display: "flex", gap: 10, alignItems: "center",
                                             padding: "8px 12px", fontSize: 11.5, color: "#e8c268" }}>
                {grab.url && <img src={grab.url} alt="" style={{ height: 84, borderRadius: 8 }} />}
                <span className="mono">{grab.note}</span>
              </div>
            )}
            <TakesStrip clip={sel} />
            </div>
            <InspectorRail clip={sel} track={selTrack} />
          </div>
          <WsTimeline onRender={() => {}} />
        </main>
      </div>
      {camOpen && (
        <CameraPicker current="close-up, static" context="S2 · beat 2" prevMove="tracking"
                      onApply={() => setCamOpen(false)} onClose={() => setCamOpen(false)} />
      )}
    </div>
  );
}

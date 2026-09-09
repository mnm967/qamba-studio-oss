import React, { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Play, Pause, SkipBack, SkipForward, Scissors, ZoomIn, ZoomOut, Clapperboard, RefreshCw } from "lucide-react";
import V2Shell from "../design/V2Shell";
import Timeline from "../components/timeline/Timeline";
import PreviewPlayer from "../components/timeline/PreviewPlayer";
import ClipInspector from "../components/timeline/ClipInspector";
import { useTimelineStore } from "../stores/useTimelineStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { ensureTimeline, syncBlocksToTimeline, timelinesForEpisode } from "../lib/db/timeline";
import { queueTimelineRender, videoClips } from "../lib/db/jobs";
import { supabase } from "../lib/supabase";
import "../styles/timeline.css";

export default function TimelinePage() {
  const { eid } = useParams<{ pid: string; eid: string }>();
  const [params] = useSearchParams();
  const store = useTimelineStore();
  const playing = usePlaybackStore((s) => s.playing);
  const toggle = usePlaybackStore((s) => s.toggle);
  const seek = usePlaybackStore((s) => s.seek);
  const [tlId, setTlId] = useState<string | null>(params.get("tl"));
  const [storyboardId, setStoryboardId] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const selected = useMemo(
    () => store.clips.find((c) => c.id === store.selectedClipId) ?? null,
    [store.clips, store.selectedClipId]
  );

  useEffect(() => {
    if (!eid) return;
    (async () => {
      let id = tlId;
      if (!id) {
        const existing = await timelinesForEpisode(eid);
        id = (existing.find((t) => t.name === "Main") ?? existing[0])?.id ?? (await ensureTimeline(eid)).id;
        setTlId(id);
      }
      await store.load(id);
      const { data: sb } = await supabase
        .from("storyboards").select("id,audio_meta").eq("episode_id", eid)
        .order("created_at", { ascending: false }).limit(1);
      if (sb?.[0]) {
        setStoryboardId(sb[0].id);
        const beats = (sb[0].audio_meta as { beats_ms?: number[] })?.beats_ms;
        if (beats) store.setBeats(beats);
      }
    })().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eid, tlId]);

  const render = async () => {
    if (!store.timeline) return;
    setRendering(true);
    try {
      await queueTimelineRender({
        timelineId: store.timeline.id,
        clips: videoClips(store.tracks, store.clips),
        episodeId: eid,
      });
    } finally {
      setRendering(false);
    }
  };

  const syncBlocks = async () => {
    if (!store.timeline || !storyboardId) return;
    await syncBlocksToTimeline(store.timeline.id, storyboardId);
    await store.load(store.timeline.id);
  };

  return (
    <V2Shell title={store.timeline?.name ?? "Timeline"} eyebrow="Editor" backTo="/" wide>
      <div className="tledit">
        <PreviewPlayer />
        <div className="tl-transport">
          <button className="tp-btn" onClick={() => seek(0)} title="Start">
            <SkipBack size={15} />
          </button>
          <button className="tp-btn" onClick={toggle} title="Play/Pause (Space)">
            {playing ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <button className="tp-btn" onClick={() => seek(usePlaybackStore.getState().durationMs)} title="End">
            <SkipForward size={15} />
          </button>
          <span className="tp-time mono">
            {store.clips.length} clips · {(store.durationMs() / 1000).toFixed(1)}s
          </span>
          <span className="tp-spacer" />
          <button className="tp-action" onClick={() => store.zoomBy(1.3)} title="Zoom in (+)">
            <ZoomIn size={13} />
          </button>
          <button className="tp-action" onClick={() => store.zoomBy(1 / 1.3)} title="Zoom out (-)">
            <ZoomOut size={13} />
          </button>
          <button className="tp-action" title="Split at playhead (S)">
            <Scissors size={13} /> S
          </button>
          {storyboardId && (
            <button className="tp-action" onClick={syncBlocks} title="Pull generated blocks onto the timeline">
              <RefreshCw size={13} /> Sync blocks
            </button>
          )}
          <button className="tp-action primary" disabled={rendering} onClick={render}>
            <Clapperboard size={13} /> Render
          </button>
        </div>
        <Timeline />
      </div>
      {selected && <ClipInspector clip={selected} />}
    </V2Shell>
  );
}

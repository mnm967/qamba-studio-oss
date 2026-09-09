import React, { useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";

interface VideoPreviewThumbProps {
  src?: string;
  className?: string;
  style?: React.CSSProperties;
  onLoadedMetadata?: (e: React.SyntheticEvent<HTMLVideoElement>) => void;
  overlayBadge?: React.ReactNode;
}

export default function VideoPreviewThumb({
  src,
  className,
  style,
  onLoadedMetadata,
  overlayBadge,
}: VideoPreviewThumbProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // The <video> mounts only once the card is NEAR the viewport, latched. The
  // library's first page is 160 cards, and mounting every one as a live
  // preload="metadata" element meant 160 concurrent range requests — and 160
  // decoder slots — before anything was on screen. An off-screen card is a box
  // until you scroll within ~300px of it; a hover before that (possible only
  // in the first instant) simply starts the load.
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setNear(true);
    }, { rootMargin: "300px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);

  const handlePointerEnter = () => {
    setNear(true);
    if (videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  };

  const handlePointerLeave = () => {
    if (videoRef.current) {
      videoRef.current.pause();
      if (videoRef.current.duration && videoRef.current.duration > 0.1) {
        videoRef.current.currentTime = 0.1;
      } else {
        videoRef.current.currentTime = 0;
      }
    }
  };

  const handleLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    if (v.duration && v.currentTime === 0) {
      v.currentTime = Math.min(0.1, v.duration * 0.1);
    }
    if (onLoadedMetadata) {
      onLoadedMetadata(e);
    }
  };

  return (
    <div
      ref={wrapRef}
      className={`video-preview-thumb-wrap ${className ?? ""}`}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        ...style,
      }}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {near && (
        <video
          ref={videoRef}
          src={src}
          muted
          loop
          playsInline
          preload="metadata"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onLoadedMetadata={handleLoadedMetadata}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
      )}
      <div className={`video-play-overlay ${isPlaying ? "playing" : ""}`}>
        <span className="video-play-btn">
          <Play size={15} fill="currentColor" style={{ marginLeft: 2 }} />
        </span>
      </div>
      {overlayBadge}
    </div>
  );
}

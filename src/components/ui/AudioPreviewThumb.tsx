import React, { useEffect, useRef, useState } from "react";
import { Music, Play, Square } from "lucide-react";

interface AudioPreviewThumbProps {
  src?: string;
  durationMs?: number | null;
  className?: string;
  style?: React.CSSProperties;
}

// Global coordinator so only one audio previews at a time across all picker cards
let activeAudioElement: HTMLAudioElement | null = null;
let stopActiveAudio: (() => void) | null = null;

const WAVE_BARS = [25, 45, 65, 35, 80, 55, 95, 70, 45, 85, 60, 90, 40, 65, 30, 50, 75, 35];

export default function AudioPreviewThumb({
  src,
  durationMs,
  className,
  style,
}: AudioPreviewThumbProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    if (!src) return;

    if (isPlaying) {
      audioRef.current?.pause();
      setIsPlaying(false);
      if (activeAudioElement === audioRef.current) {
        activeAudioElement = null;
        stopActiveAudio = null;
      }
      return;
    }

    // Stop any previously playing audio in the picker
    if (stopActiveAudio) {
      stopActiveAudio();
    }

    if (!audioRef.current) {
      const audio = new Audio(src);
      audio.onended = () => {
        setIsPlaying(false);
        if (activeAudioElement === audio) {
          activeAudioElement = null;
          stopActiveAudio = null;
        }
      };
      audio.onerror = () => {
        setIsPlaying(false);
        if (activeAudioElement === audio) {
          activeAudioElement = null;
          stopActiveAudio = null;
        }
      };
      audioRef.current = audio;
    }

    activeAudioElement = audioRef.current;
    stopActiveAudio = () => {
      audioRef.current?.pause();
      setIsPlaying(false);
    };

    audioRef.current
      .play()
      .then(() => setIsPlaying(true))
      .catch(() => setIsPlaying(false));
  };

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        if (activeAudioElement === audioRef.current) {
          activeAudioElement = null;
          stopActiveAudio = null;
        }
      }
    };
  }, []);

  const durLabel = durationMs ? `${(durationMs / 1000).toFixed(1)}s` : null;

  return (
    <div
      className={`audio-preview-thumb-wrap ${className ?? ""}`}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "radial-gradient(ellipse at 50% 35%, rgba(138, 75, 255, 0.22), rgba(8, 11, 17, 0.95))",
        borderRadius: 8,
        userSelect: "none",
        ...style,
      }}
    >
      {/* Visualizer bars */}
      <div className="audio-wave-bars">
        {WAVE_BARS.map((height, i) => (
          <span
            key={i}
            className={`audio-wave-bar ${isPlaying ? "playing" : ""}`}
            style={{
              height: `${height}%`,
              animationDelay: `${(i % 5) * 0.12}s`,
            }}
          />
        ))}
      </div>

      {/* Center Action Overlay */}
      <div className={`audio-play-overlay ${isPlaying ? "playing" : ""}`}>
        <button
          type="button"
          className="audio-play-btn"
          title={isPlaying ? "Stop audio preview" : "Preview audio"}
          onClick={togglePlay}
          aria-label={isPlaying ? "Stop audio preview" : "Preview audio"}
        >
          {isPlaying ? (
            <Square size={13} fill="currentColor" />
          ) : (
            <Play size={14} fill="currentColor" style={{ marginLeft: 2 }} />
          )}
        </button>
      </div>

      {/* Duration Badge */}
      {durLabel && (
        <span className="audio-preview-dur mono">
          {durLabel}
        </span>
      )}
    </div>
  );
}

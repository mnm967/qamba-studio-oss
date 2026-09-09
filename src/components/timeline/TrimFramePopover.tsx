// WHICH FRAME A TRIM WILL LAND ON, while the handle is still moving.
//
// A trim used to report itself as a width and a "10.4s" label, so the one
// question being asked — does this land before or after she turns her head —
// was answerable only by letting go and scrubbing. The card names the frame,
// shows it, and says what the clip will be worth if you release here.
//
// It reads the PATCHED clip rather than the pointer (see `trimReadout`), so
// what it shows is what the store already holds: clamps, the media's own
// ends and the snap grid are all applied before it is asked.
import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { mediaUrl } from "../../lib/supabase";
import { isStill } from "../../lib/assetKind";
import { formatTc, type TrimReadout } from "../../lib/clipFrames";
import type { Asset } from "../../lib/db/types";

/** Roughly the card's own width — used only to keep it inside the viewport
 *  when the edge being dragged is near one. The transform does the centring,
 *  so being a few px out costs nothing. */
const CARD_W = 178;
const LIMIT_TEXT: Record<string, string> = {
  "media-start": "start of the media",
  "media-end": "end of the media",
  "min-length": "shortest clip allowed",
};

export default function TrimFramePopover({
  asset, readout, x, y, audio,
}: {
  asset: Asset | null;
  readout: TrimReadout;
  /** Viewport x of the EDGE being dragged, and the top of its lane. */
  x: number;
  y: number;
  audio: boolean;
}) {
  const vid = useRef<HTMLVideoElement>(null);
  /** The seek we want to be showing. Held in a ref because a seek in flight
   *  cannot be redirected — `currentTime =` during one is dropped by the
   *  decoder, silently, which on a fast drag leaves the card frozen on
   *  whichever frame happened to be mid-seek when the drag sped up. */
  const want = useRef(0);

  const still = isStill(asset);
  const url = asset ? mediaUrl(asset.b2_key) : null;

  const apply = () => {
    const el = vid.current;
    if (!el || el.seeking || !Number.isFinite(el.duration)) return;
    if (Math.abs(el.currentTime - want.current) > 0.001) el.currentTime = want.current;
  };

  useEffect(() => {
    want.current = readout.seekMs / 1000;
    apply();
  }, [readout.seekMs]);

  // Kept inside the viewport, but never at the cost of leaving it: clamping
  // the right edge FIRST puts the card off-screen entirely whenever the two
  // bounds cross, which they do the instant a layout read comes back
  // degenerate (measured — a lane mid-resize reports width 0 and takes
  // `innerWidth` with it, and the card flew off the left of the screen).
  const half = CARD_W / 2 + 8;
  const left = Math.max(half, Math.min(x, Math.max(half, window.innerWidth - half)));

  const dur = (readout.durationMs / 1000).toFixed(2);
  const delta = readout.deltaMs;
  const sign = delta > 0 ? "+" : "−";

  return createPortal(
    <div
      className="ws-trimfp"
      style={{ left, top: Math.max(8, y - 8) }}
    >
      {!audio && url && (
        <div className="tfp-pic">
          {still
            ? <img src={url} alt="" />
            : (
              <video
                ref={vid}
                src={url}
                muted
                playsInline
                preload="auto"
                onLoadedMetadata={apply}
                onSeeked={apply}
              />
            )}
        </div>
      )}
      <div className="tfp-meta">
        <span className={"tfp-edge " + readout.edge}>{readout.edge === "in" ? "IN" : "OUT"}</span>
        <b className="mono">
          {/* A still is one frame by definition, and audio has none at all;
              naming an index in either case is arithmetic dressed up as a
              fact about the media. Both read the exact cut instead. */}
          {audio || still ? formatTc(readout.cutMs) : `f${readout.frame}`}
        </b>
      </div>
      {/* Its OWN line. Beside the frame number it fit only while both were
          short — `OUT f251 0:10.000 · of 252` already runs past a 178px card,
          and a four-digit frame or an hour-long source runs further. */}
      {!audio && !still && (
        <div className="tfp-tc mono">
          {formatTc(readout.srcMs)}{readout.frames != null ? ` · of ${readout.frames}` : ""}
        </div>
      )}
      <div className="tfp-len mono">
        {dur}s
        {delta !== 0 && <i>{sign}{(Math.abs(delta) / 1000).toFixed(2)}s</i>}
      </div>
      {readout.limit && <div className="tfp-limit">{LIMIT_TEXT[readout.limit]}</div>}
    </div>,
    document.body
  );
}

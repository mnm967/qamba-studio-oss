import React, { useEffect, useRef, useState } from "react";
import { mediaUrl } from "../../lib/supabase";
import { readStrip, cellBox, type StripLayout } from "../../lib/previewStrip";
import type { Job } from "../../lib/db/types";

/** How many sampler sheets to keep for the hover scrub. Each is a ~25KB JPEG,
 *  but they stay DECODED while mounted, so this is the real cost: ~0.5MB of
 *  bitmap each, strip or not (a 4-cell strip is four 256px cells where a plain
 *  preview was one 512px frame — same pixels, rearranged). Ten covers a 20-step
 *  render at the rate the worker publishes (every 6s) without making a popover
 *  of running jobs expensive. */
const MAX_FRAMES = 10;
/** Walking the sampler history: 8fps over up to ten steps of denoising. */
const PLAY_FPS = 8;
/** Walking a strip's cells. Half the rate, because these are four samples of a
 *  13-second shot rather than ten steps of one moment — at 8fps a four-frame
 *  loop is a flicker you cannot read anything out of. */
const CELL_FPS = 4;

/**
 * The live sampler frame for a running job, and the ones before it.
 *
 * An H3 preview is a STRIP: the pod decodes four moments across the shot and
 * joins them into one sheet (`worker/comfy_nodes/neon_h3_preview`), so hovering
 * plays the SHOT rather than the denoising. Everything else in the queue — a
 * Krea 2 still, a Wan clip, an H3 render on a pod that has not been redeployed
 * — arrives as a single frame from core's own previewer, and hovering there
 * still walks the sampler history as it always did. `readStrip` tells the two
 * apart from the image's pixel size, which is the only information a preview
 * carries; `src/lib/previewStrip.ts` explains why that is enough.
 *
 * The frames CANNOT be captured into a canvas or re-fetched into blobs: the B2
 * bucket sends no `Access-Control-Allow-Origin`, so `fetch` is refused and a
 * drawn image taints the canvas (the same wall the take filmstrip hit). What
 * does work is leaving every frame mounted as its own `<img>` — the browser
 * keeps each decoded, so scrubbing costs no network at all and cannot be
 * defeated by a cache miss. That is why these are stacked and cross-faded
 * rather than swapped through one `src`, and why a strip is cropped by sliding
 * an oversized `<img>` inside an overflow-hidden box rather than by drawing it.
 *
 * One preview object per job, overwritten in place, so `?p=<progress>` is both
 * the cache-buster AND the only thing that distinguishes one sample from the
 * next. Progress moves faster than the 6s publish interval, so two frames can
 * carry identical bytes; that reads as a pause in the scrub and is not worth
 * the CORS fight to detect.
 */
/**
 * One preview image, cropped to its first cell when it is a strip.
 *
 * The library's pending card shows the same B2 object the queue does, through
 * `.ws-libthumb img` — which COVERS its box, and on a four-cell sheet that
 * lands on the seam between cells 1 and 2: half of one moment beside half of
 * another, in a card whose whole job is to be a picture-shaped hole where the
 * picture is going to be. Same crop as below, one image, no animation.
 */
export function PreviewFrame({ url, className }: { url: string; className?: string }) {
  const [layout, setLayout] = useState<StripLayout | null>(null);
  const isStrip = (layout?.cells ?? 1) > 1;
  return (
    <img
      className={className} src={url} alt="" draggable={false}
      // `contain`, not the card's usual `cover`: the box carries the CELL's
      // shape while the image is four of them, so covering would crop the
      // sheet's own edges and slide every cell boundary off by a fifth of a
      // cell. Left unset entirely for a plain frame, so nothing changes for
      // every other model in the queue.
      style={isStrip ? { ...cellBox(layout!, 0), objectFit: "contain" } : undefined}
      onLoad={(e) => {
        if (layout) return;
        const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
        if (w && h) setLayout(readStrip(w, h));
      }}
    />
  );
}

/** Takes the two fields it reads rather than a whole `Job`: the takes strip
 *  renders the same live frame from a `ClipJob`, which is the same row through
 *  a narrower select. */
export default function JobPreview({ job }: { job: Pick<Job, "progress" | "preview_key"> }) {
  const pct = Math.round((job.progress || 0) * 100);
  const url = job.preview_key ? `${mediaUrl(job.preview_key)}?p=${pct}` : null;

  const [frames, setFrames] = useState<string[]>([]);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const posRef = useRef(0);
  // The sheet's layout, read off the first frame that loads. A job does not
  // reliably carry its dimensions (a block's live on the block, a clip's on the
  // payload), and the image states them exactly — the worker's preview keeps
  // the render's aspect in each CELL when it caps the sheet's long side.
  const [layout, setLayout] = useState<StripLayout | null>(null);

  useEffect(() => {
    if (!url) return;
    setFrames((f) => (f[f.length - 1] === url ? f : [...f, url].slice(-MAX_FRAMES)));
  }, [url]);

  // A strip animates its own cells (the shot moving) and a plain preview
  // animates the history (the picture resolving). Same loop, two axes.
  const isStrip = (layout?.cells ?? 1) > 1;
  const steps = isStrip ? layout!.cells : frames.length;
  const fps = isStrip ? CELL_FPS : PLAY_FPS;

  useEffect(() => {
    if (!playing || steps < 2) return;
    const t = setInterval(() => {
      posRef.current = (posRef.current + 1) % steps;
      setPos(posRef.current);
    }, 1000 / fps);
    return () => clearInterval(t);
  }, [playing, steps, fps]);

  // No frame yet — a job that has just been claimed, or one still loading a
  // checkpoint. The bar holds the slot so the row doesn't resize under the
  // pointer the moment the first frame lands.
  if (!frames.length) return <div className="ws-jobbar"><i style={{ width: `${pct}%` }} /></div>;

  // Idle is always the newest sheet's first cell — a still that resolves as the
  // render goes, which is what this is for at a glance.
  const at = playing ? Math.min(pos, steps - 1) : 0;
  const shownFrame = isStrip || !playing ? frames.length - 1 : at;
  const box = layout ? cellBox(layout, isStrip ? at : 0) : undefined;
  const scrubbable = steps > 1;

  return (
    <div
      className={"ws-jobprev" + (playing ? " play" : "")}
      // Drives both the box's shape and its width cap (see .ws-jobprev): a
      // portrait render gets a portrait box rather than a 16:9 one that crops
      // its sides off. This is the CELL's aspect, i.e. the render's, whether or
      // not the sheet it came out of is four times as wide.
      style={layout?.cellAr ? ({ "--ar": String(layout.cellAr) } as React.CSSProperties) : undefined}
      title={!scrubbable ? undefined
        : isStrip ? "Hover to play the shot" : "Hover to replay the sample so far"}
      onMouseEnter={() => {
        if (!scrubbable) return;
        posRef.current = 0;
        setPos(0);
        setPlaying(true);
      }}
      onMouseLeave={() => setPlaying(false)}
    >
      {frames.map((f, i) => (
        <img key={f} src={f} alt="" draggable={false} style={box}
             className={"ws-jobprev-f" + (i === shownFrame ? " on" : "")}
             onLoad={(e) => {
               if (layout) return;
               const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
               if (w && h) setLayout(readStrip(w, h));
             }} />
      ))}
      <div className="ws-jobprev-bar"><i style={{ width: `${pct}%` }} /></div>
      {playing && scrubbable && (
        <span className="ws-jobprev-tag mono">{at + 1}/{steps}</span>
      )}
    </div>
  );
}

import { uploadStill } from "./upload";
import { registerAsset } from "./db/assets";
import { mediaUrl } from "./supabase";
import { isStill } from "./assetKind";
import { clipSourceMs, frameMs } from "./clipFrames";
import { describePlan, rasterPlan, type RasterPlan } from "./clipRaster";
import type { Asset, Clip } from "./db/types";

/**
 * Draw a source into a canvas with the clip's visual ops applied, and hand
 * back a JPEG.
 *
 * The ops are the WHOLE point. Without them a clip carrying `flip h` — one
 * click in the Transform panel — extracts an unmirrored frame, and that frame
 * is not just the modal's thumbnail: it is `start_asset_id`, the picture the
 * generated extend or chain opens on. The bridge then opens on a mirror image
 * of the shot before it. See lib/clipRaster.ts for what is applied and the two
 * things deliberately are not.
 */
function paint(src: CanvasImageSource, w: number, h: number, plan: RasterPlan): Promise<Blob> {
  const rotated = plan.rotate % 180 !== 0;
  const canvas = document.createElement("canvas");
  // A rotation of anything but a half-turn changes the bounding box; keeping
  // the whole picture is what stops a 90° clip losing its sides.
  canvas.width = Math.max(1, Math.round(rotated ? plan.out.h : plan.out.w));
  canvas.height = Math.max(1, Math.round(rotated ? plan.out.w : plan.out.h));
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("Could not get 2D context from canvas"));

  ctx.translate(canvas.width / 2, canvas.height / 2);
  if (plan.rotate) ctx.rotate((plan.rotate * Math.PI) / 180);
  // Mirror about the centre, after the rotation — the order ffmpeg's own
  // [flip, …] chain produces once the window has been taken.
  if (plan.flipH || plan.flipV) ctx.scale(plan.flipH ? -1 : 1, plan.flipV ? -1 : 1);
  ctx.drawImage(
    src,
    plan.src.x, plan.src.y, Math.max(1, plan.src.w), Math.max(1, plan.src.h),
    -plan.out.w / 2, -plan.out.h / 2, plan.out.w, plan.out.h);

  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas toBlob returned null"))),
                  "image/jpeg", 0.92);
  });
}

/** The whole frame, no ops — what a caller that is not a timeline clip wants. */
function wholeFrame(w: number, h: number): RasterPlan {
  return { src: { x: 0, y: 0, w, h }, out: { w, h },
           flipH: false, flipV: false, rotate: 0, cropped: false, plain: true };
}

/**
 * Capture a frame from an image URL using HTMLImageElement and canvas.
 * Returns a JPEG Blob.
 */
export function captureImageFrame(imageUrl: string, plan?: RasterPlan): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";

    img.onload = () => {
      const w = img.naturalWidth || 1280;
      const h = img.naturalHeight || 720;
      paint(img, w, h, plan ?? wholeFrame(w, h)).then(resolve, reject);
    };

    img.onerror = () => {
      reject(new Error("Failed to load image for frame extraction"));
    };

    img.src = imageUrl;
  });
}

/** How close to the requested instant a seek has to land to be accepted.
 *  50ms is a little over one frame at 24fps — a decoder lands on a frame
 *  boundary, not on an arbitrary time, so demanding better than that is
 *  demanding something no browser offers. */
const SEEK_TOLERANCE_SEC = 0.05;
/** Re-aims before accepting whatever the decoder settled on. A handful: each
 *  costs one seek, and a decoder that has not converged in six is not going to. */
const MAX_SEEK_TRIES = 8;
/** Consecutive re-aims that moved the playhead nowhere before we accept that
 *  it cannot move. Measured against a server with no Range support: the
 *  position stays at 0 forever, so this is what ends it. */
const MAX_STALLS = 3;
/** Nothing here used to have a timeout, so a media element that never fired
 *  `seeked` (an unseekable stream, a dead range request) left the promise
 *  pending for the life of the page and the modal on "Extracting frames…". */
const SEEK_TIMEOUT_MS = 20000;
/** Past this, the seek did not happen at all and the frame on screen is
 *  whatever the element loaded with — usually frame 0. Returning it is the
 *  silent wrong answer this whole module exists to stop, so it is an ERROR:
 *  `captureVideoFrame` then falls through to its blob-URL attempt, which is
 *  fully seekable by construction and measured landing exactly on target. */
const SEEK_GIVEUP_SEC = 0.5;

/**
 * Put a video element on `atSec` and RESOLVE WITH WHERE IT ACTUALLY LANDED.
 *
 * This exists because the obvious version is wrong in a way that produces a
 * perfectly good picture of the wrong moment. Setting `currentTime` while the
 * element is ALREADY seeking — which it is during its own load — is dropped by
 * the decoder silently: no error, no event, no second chance. The old code
 * assigned `currentTime` inside `onloadedmetadata` and then captured on the
 * first `seeked`, which is the LOAD's own seek to zero. Measured against the
 * real files: two extracts that recorded 6.233s and 1.780s in their metadata
 * were SSIM 0.999 against frame 0 and 0.002 / 0.038 against the frames they
 * claimed. Every extend and every chain in the app was anchored on the opening
 * frame of its block.
 *
 * So the rule is: never write `currentTime` during a seek, re-aim on every
 * `seeked` until we are within tolerance, and take the element's OWN
 * `currentTime` as the answer rather than the number we asked for.
 */
export async function aimVideoAt(
  video: HTMLVideoElement,
  atSec: number,
  opts: { endGuardSec?: number; signal?: { aborted: boolean } } = {}
): Promise<number> {
  const endGuard = Math.max(0, opts.endGuardSec ?? 0.1);
  return new Promise<number>((resolve, reject) => {
    let target = Math.max(0, atSec);
    let tries = 0;
    let stalls = 0;
    let lastAt = NaN;
    let done = false;

    const events = ["loadedmetadata", "loadeddata", "canplay", "seeked"] as const;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const e of events) video.removeEventListener(e, aim);
      video.removeEventListener("error", fail);
      fn();
    };
    const settle = () => finish(() => {
      const off = Math.abs(video.currentTime - target);
      if (off > SEEK_GIVEUP_SEC) {
        // Almost always an unseekable source: a server that does not answer
        // Range leaves `video.seekable` empty and every `currentTime =` write
        // is a no-op. Say so — this was diagnosed once by downloading the
        // uploaded frames and comparing them against ffmpeg's.
        const span = video.seekable.length ? video.seekable.end(0) : 0;
        reject(new Error(
          `seek did not land: wanted ${target.toFixed(3)}s, got ${video.currentTime.toFixed(3)}s ` +
          `(seekable to ${span.toFixed(2)}s) — the source is probably not answering Range requests`
        ));
        return;
      }
      resolve(video.currentTime);
    });
    const fail = () => finish(() => reject(new Error("Failed to load video for frame extraction")));

    function aim() {
      if (done) return;
      if (opts.signal?.aborted) return finish(() => reject(new Error("aborted")));
      if (video.readyState < 1) return;   // no duration yet — a later event brings us back
      // A write now would be swallowed whole. `seeked` calls us again.
      if (video.seeking) return;
      const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
      if (dur != null) target = Math.min(target, Math.max(0, dur - endGuard));
      const at = video.currentTime;
      if (Math.abs(at - target) <= SEEK_TOLERANCE_SEC) return settle();
      // Not moving is not the same as not moving ONCE: the first write of a
      // pair is routinely swallowed because the element was still doing its
      // own load seek, and giving up there is what produced frame 0. Give it
      // a few goes before believing the decoder cannot get closer.
      if (at === lastAt) { if (++stalls > MAX_STALLS) return settle(); } else stalls = 0;
      if (tries >= MAX_SEEK_TRIES) return settle();
      lastAt = at;
      tries++;
      video.currentTime = target;
    }

    const timer = setTimeout(() => {
      // Something to draw beats nothing; only a element with no frame at all
      // is a failure.
      if (video.readyState >= 2) settle();
      else fail();
    }, SEEK_TIMEOUT_MS);

    for (const e of events) video.addEventListener(e, aim);
    video.addEventListener("error", fail);
    aim();
  });
}

/** A frame, and the instant it was REALLY taken from — which is not always the
 *  instant that was asked for, and must not be recorded as though it were. */
export interface CapturedFrame { blob: Blob; atSec: number }

/**
 * Capture a frame from a video URL at a specific timestamp (in seconds).
 * Uses CORS fallback to Blob URL if direct HTMLVideoElement crossOrigin fails.
 *
 * `endGuardSec` is how far short of the media's own end a seek is allowed to
 * land — seeking to exactly `duration` reliably returns nothing. It was a flat
 * 100ms, which at 24fps is two and a half frames: fine as a safety rail,
 * wrong as the answer to "the last frame of this shot", which is what an
 * untrimmed chain asks for. Callers that have computed a real frame boundary
 * pass half a frame instead and keep their own arithmetic.
 */
export async function captureVideoFrame(
  videoUrl: string,
  timestampSec: number,
  endGuardSec = 0.1,
  plan?: RasterPlan
): Promise<CapturedFrame> {
  const extractFromUrl = async (src: string, crossOrigin?: string): Promise<CapturedFrame> => {
    const video = document.createElement("video");
    if (crossOrigin) video.crossOrigin = crossOrigin;
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = src;
    video.load();
    try {
      const atSec = await aimVideoAt(video, timestampSec, { endGuardSec });
      // Draw only once a frame for THIS position has been presented.
      // `drawImage` reads the last painted frame, which during a seek is still
      // the previous one — the 120ms sleep was standing in for this.
      await presented(video);
      const w = video.videoWidth || 1280;
      const h = video.videoHeight || 720;
      // With the clip's own ops applied — see lib/clipRaster.ts. A `flip h`
      // clip drawn raw yields an anchor mirrored against the timeline.
      const blob = await paint(video, w, h, plan ?? wholeFrame(w, h));
      return { blob, atSec };
    } finally {
      video.removeAttribute("src");
      video.load();
    }
  };

  // Attempt 1: Direct URL with anonymous CORS
  try {
    return await extractFromUrl(videoUrl, "anonymous");
  } catch (err) {
    console.warn("Direct video frame extraction failed, trying blob URL fallback:", err);
  }

  // Attempt 2: Fetch as blob -> local object URL (bypasses CORS restrictions on video element)
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    const videoBlob = await res.blob();
    const blobUrl = URL.createObjectURL(videoBlob);
    try {
      return await extractFromUrl(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  } catch (err) {
    throw new Error("Failed to load video for frame extraction");
  }
}

/** Resolve once the decoder has PAINTED a frame. `requestVideoFrameCallback`
 *  is the exact signal and is in Chromium and WebKit; the sleep is the Firefox
 *  fallback and is what the whole function used to be. */
function presented(video: HTMLVideoElement): Promise<void> {
  const rvfc = (video as unknown as {
    requestVideoFrameCallback?: (cb: () => void) => number;
  }).requestVideoFrameCallback;
  if (typeof rvfc === "function") {
    return new Promise((res) => {
      let settled = false;
      const go = () => { if (!settled) { settled = true; res(); } };
      rvfc.call(video, go);
      // A paused element that is already showing the right frame may never
      // present another one.
      setTimeout(go, 300);
    });
  }
  return new Promise((res) => setTimeout(res, 120));
}

/**
 * MEDIA IS ALREADY REACHABLE, so there is nothing to proxy.
 *
 * The cloud build sent a cross-origin object through a server-side proxy, for
 * one reason: a `<video>` cannot be seeked reliably through a transport with no
 * Range support, and the bucket's own CORS rule did not cover every origin. A
 * project's media here is served by the app's own loopback media server, which
 * speaks Range and answers `Access-Control-Allow-Origin: *` — so the element
 * can seek it and a canvas can read it, which is the whole requirement.
 *
 * Kept as a named function rather than inlined: it is the one place that would
 * have to change if media ever came from somewhere else again, and a caller
 * reading `proxyUrlIfNeeded(url)` says that question was asked.
 */
function proxyUrlIfNeeded(rawUrl: string): string {
  return rawUrl;
}

/**
 * Extract the FIRST or LAST frame a clip actually shows, upload it to B2 and
 * register it as an asset.
 *
 * "Actually shows" is the whole of it, and it is why the timestamp comes from
 * `clipSourceMs` rather than from the asset: the frame an extend continues
 * from, or a chain bridges to, has to be the frame at the TRIMMED boundary.
 * Trim the tail and the end frame moves back with the handle; trim the head
 * and the opening frame moves forward. See lib/clipFrames.ts for why `out_ms`
 * is not the trim point it looks like.
 *
 * A STILL has one frame, so `position` cannot mean anything there — and that
 * is a routine state on a video lane, not a corner case: every generate action
 * in the timeline parks an extracted still on the lane while the GPU works.
 * The still is returned (it is the only picture there is) and the result says
 * so in `meta.position_applied`, so a caller can warn rather than present a
 * placeholder as "the end of the shot".
 */
export function extractAndSaveClipFrame(
  clip: Clip,
  asset: Asset | undefined,
  position: "first" | "last"
): Promise<Asset> {
  // A clip carrying no duration says nothing about where it ends, so seek
  // past the media and let the guard land on its last frame — the old
  // behaviour, kept for exactly that case rather than as the general rule.
  const unknownEnd = position === "last" && !(clip.duration_ms > 0);
  return saveFrame(clip, asset, {
    position,
    atMs: unknownEnd ? null : clipSourceMs(clip, position, asset),
  });
}

/**
 * The frame the player is showing at `srcMs`, saved to the library.
 *
 * The instant comes from `lib/playheadFrame.ts` — the preview's own mapping,
 * NOT `clipSourceMs`'s — because this is "the picture I am looking at" rather
 * than "the frame the delivered shot ends on". The two disagree on a reversed
 * clip, and handing back a frame the screen has never shown is the silent
 * wrong answer this module exists to stop.
 *
 * `timelineMs` is recorded only so the grab can be traced back to a position
 * on the cut; where the frame REALLY came from is `extracted_at_sec`, as
 * everywhere else here.
 */
export function extractAndSavePlayheadFrame(
  clip: Clip,
  asset: Asset | undefined,
  srcMs: number,
  timelineMs: number
): Promise<Asset> {
  return saveFrame(clip, asset, {
    position: "playhead",
    atMs: Math.max(0, srcMs),
    meta: { timeline_ms: Math.round(timelineMs) },
  });
}

/** What every saved frame shares: seek, draw with the clip's ops, upload,
 *  register. `position` names the grab in the filename, the tag and the meta;
 *  a null `atMs` means "past the end — give me whatever the last frame is". */
async function saveFrame(
  clip: Clip,
  asset: Asset | undefined,
  req: { position: string; atMs: number | null; meta?: Record<string, unknown> }
): Promise<Asset> {
  const { position } = req;
  if (!asset) {
    throw new Error("Asset missing for clip frame extraction");
  }

  const rawUrl = mediaUrl(asset.b2_key);
  if (!rawUrl) {
    throw new Error("Could not resolve media URL for asset");
  }

  const url = proxyUrlIfNeeded(rawUrl);

  // `isStill` is the app-wide answer (kind first, content-type second); the
  // key sniff stays on top of it because an asset registered as `video` with a
  // .jpg key must still yield its picture rather than hang a <video> forever.
  const isImage =
    isStill(asset) ||
    url.startsWith("data:image/") ||
    /\.(jpe?g|png|webp|gif|svg|avif|bmp)$/i.test(asset.b2_key);

  let blob: Blob;
  /** Where the frame was really taken from; null when the seek had to fall
   *  back to "past the end of the media" and the exact instant is unknown. */
  let atMs: number | null = 0;
  // THE CLIP'S OWN LOOK, not the raw media's. A clip carrying `flip h` — one
  // click in the Transform panel — used to extract an unmirrored frame, and
  // that frame is `start_asset_id`: the picture the generated extend or chain
  // OPENS ON. So the bridge opened on a mirror image of the shot before it,
  // and the modal's thumbnail agreed with the render rather than with the
  // timeline, which is where you would look to catch it.
  const plan = rasterPlan(clip, asset);

  if (isImage) {
    try {
      blob = await captureImageFrame(url, plan);
    } catch {
      // Fallback: fetch blob directly if canvas draw fails
      const resp = await fetch(url);
      blob = await resp.blob();
    }
  } else {
    atMs = req.atMs;
    const timeSec = atMs == null ? 999999 : atMs / 1000;

    try {
      // Half a frame of guard: clipSourceMs has already stepped back off the
      // cut, so this only has to stop a seek landing on `duration` itself.
      const shot = await captureVideoFrame(url, timeSec, frameMs(asset) / 2000, plan);
      blob = shot.blob;
      // WHAT THE DECODER GAVE US, not what we asked for. Recording the request
      // is what let a whole app's worth of extends and chains sit on frame 0
      // while their metadata read like the trim had been honoured.
      atMs = shot.atSec * 1000;
      if (timeSec !== 999999 && Math.abs(shot.atSec - timeSec) > 2 * frameMs(asset) / 1000) {
        console.warn(
          `frame extract landed ${shot.atSec.toFixed(3)}s away from the requested ${timeSec.toFixed(3)}s`
        );
      }
    } catch (videoErr) {
      console.warn("Video frame capture failed, trying image fallback:", videoErr);
      try {
        blob = await captureImageFrame(url, plan);
      } catch {
        throw new Error(
          videoErr instanceof Error ? videoErr.message : "Failed to load video for frame extraction"
        );
      }
    }
  }

  const file = new File([blob], `frame_${position}_${Date.now()}.jpg`, { type: "image/jpeg" });

  const projectId = asset.project_id ?? "project";
  const b2Key = `${projectId}/frames/frame_${position}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`;

  const { key } = await uploadStill(file, b2Key);

  const registered = await registerAsset({
    b2_key: key,
    kind: "image",
    project_id: asset.project_id,
    content_type: "image/jpeg",
    origin: "derived",
    meta: {
      source_clip_id: clip.id,
      source_asset_id: asset.id,
      frame_position: position,
      // The instant this frame was really taken from. It used to record the
      // clip's in-point whatever the position, so a correctly grabbed last
      // frame was filed as having come from the start of the shot.
      extracted_at_sec: isImage ? 0 : atMs == null ? null : atMs / 1000,
      // False when the source is a still: one picture, so "first" and "last"
      // are the same frame and neither is the end of a shot.
      position_applied: !isImage,
      // What the clip's ops did to it. An anchor that looks wrong is otherwise
      // indistinguishable from a bad extract.
      ops_applied: describePlan(plan),
      source_kind: isImage ? "still" : "video",
      prompt: clip.label ?? asset.b2_key.split("/").pop() ?? undefined,
      ...req.meta,
    },
    tags: ["extracted_frame", position],
  });

  return registered;
}


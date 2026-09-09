/**
 * MEASURE A MEDIA FILE'S LENGTH IN THE BROWSER.
 *
 * `assets.duration_ms` is filled in by the pod's `asset_ingest` job, so until
 * that job runs the registry does not know how long an uploaded file is — and
 * every consumer of that number then falls back to a constant. On the timeline
 * that is `insertAsset`'s 4000ms: a six-minute mp3 lands as a four-second clip,
 * nothing errors, and the only trace is one `queued` job on a box that may be
 * stopped. Measured on the live rows (2026-08-23): two audio uploads with
 * `duration_ms` null and both of their ingest jobs still queued an hour later.
 *
 * The browser already has everything needed to answer it. A media element
 * loading only its metadata reports `duration`, and — unlike a canvas capture —
 * reading that number needs no CORS grant, so it works against the public
 * bucket exactly as it works against a local blob.
 *
 * Nothing here touches the DOM at module scope, so the pure half below is
 * reachable from `node --test`.
 */

/** Never leave a promise pending on a source that stops answering — the rule
 *  `frameExtractor` learned the hard way. */
const PROBE_TIMEOUT_MS = 15000;

/** Past a day, the number is a decoder artefact rather than a file. */
const MAX_PLAUSIBLE_SEC = 24 * 60 * 60;

export interface MediaMeta {
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

/** Seconds off a media element -> the milliseconds this app stores, or null.
 *
 *  `duration` is NaN before metadata arrives and **Infinity** for a stream the
 *  container cannot size — a VBR mp3 with no Xing header is the common one, and
 *  is exactly what a user drags in. Neither is a length, and rounding either
 *  produces a number that looks measured. */
export function msFromSeconds(sec: unknown): number | null {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return null;
  if (sec <= 0 || sec > MAX_PLAUSIBLE_SEC) return null;
  return Math.round(sec * 1000);
}

/** Is this the Infinity case that a seek past the end resolves?
 *
 *  Only Infinity — NaN means metadata has not arrived yet, and seeking then
 *  would be a write during the element's own load, which is dropped silently
 *  (the same trap `aimVideoAt` documents). */
export function needsEndSeek(sec: unknown): boolean {
  return sec === Infinity;
}

/** Which element can read this file. Null for anything with no timeline of its
 *  own — a still has no duration and a `<video>` never finishes loading one. */
export function probeElementFor(
  hint: { kind?: string | null; content_type?: string | null; b2_key?: string | null },
): "audio" | "video" | null {
  const ct = (hint.content_type ?? "").toLowerCase();
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("image/")) return null;
  const kind = (hint.kind ?? "").toLowerCase();
  if (kind === "audio") return "audio";
  if (kind === "video" || kind === "render") return "video";
  if (kind === "image" || kind === "frame") return null;
  const key = hint.b2_key ?? "";
  if (/\.(mp3|wav|m4a|aac|ogg|oga|flac|opus)$/i.test(key)) return "audio";
  if (/\.(mp4|mov|webm|mkv|m4v)$/i.test(key)) return "video";
  return null;
}

/**
 * Load just enough of `src` to read its length (and, for video, its frame
 * size). Resolves null when the source cannot be measured at all — which the
 * caller must be able to tell apart from "measured, and it is short".
 */
export async function probeMediaMeta(
  src: Blob | string,
  opts: { element?: "audio" | "video"; timeoutMs?: number } = {},
): Promise<MediaMeta | null> {
  if (typeof document === "undefined") return null;

  const blobUrl = typeof src === "string" ? null : URL.createObjectURL(src);
  const url = blobUrl ?? (src as string);
  const wantAudio = opts.element
    ? opts.element === "audio"
    : (typeof src !== "string" && (src.type || "").startsWith("audio/"));
  const el = document.createElement(wantAudio ? "audio" : "video") as HTMLMediaElement;

  return new Promise<MediaMeta | null>((resolve) => {
    let done = false;
    let sought = false;

    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener("loadedmetadata", read);
      el.removeEventListener("durationchange", read);
      el.removeEventListener("error", fail);
      // Stop the fetch: an abandoned element goes on pulling bytes, and on a
      // 6MB upload that is the whole file for a number we already have.
      try { el.removeAttribute("src"); el.load(); } catch { /* detached already */ }
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };

    const settle = (meta: MediaMeta | null) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(meta);
    };

    const dims = () => {
      const v = el as HTMLVideoElement;
      return {
        width: v.videoWidth > 0 ? v.videoWidth : null,
        height: v.videoHeight > 0 ? v.videoHeight : null,
      };
    };

    function read() {
      if (done) return;
      const ms = msFromSeconds(el.duration);
      if (ms != null) return settle({ durationMs: ms, ...dims() });
      if (!needsEndSeek(el.duration) || sought) return;   // NaN: a later event brings us back
      // An unsized stream reports Infinity until something asks for the end.
      // Seeking there makes the decoder resolve it and fire `durationchange`.
      sought = true;
      try { el.currentTime = 1e101; } catch { try { el.currentTime = MAX_PLAUSIBLE_SEC; } catch { /* refused */ } }
    }

    const fail = () => settle(null);

    // A source that answered SOMETHING beats giving up: the seek trick can
    // leave the duration correct while the element never fires again.
    const timer = setTimeout(() => {
      const ms = msFromSeconds(el.duration);
      settle(ms == null ? null : { durationMs: ms, ...dims() });
    }, opts.timeoutMs ?? PROBE_TIMEOUT_MS);

    el.addEventListener("loadedmetadata", read);
    el.addEventListener("durationchange", read);
    el.addEventListener("error", fail);
    el.preload = "metadata";
    el.muted = true;
    el.src = url;
    try { el.load(); } catch { /* some engines load on src alone */ }
  });
}

/**
 * What an upload knows about itself, shaped to spread straight into
 * `registerAsset`. Measuring here is what stops the null existing in the first
 * place: the pod's ingest still runs afterwards for waveform peaks and the rest,
 * but the length no longer waits on a box that may be stopped.
 *
 * Never throws and never blocks an upload — a file we cannot read is registered
 * exactly as it was before.
 */
export async function probedUploadMeta(
  file: File | Blob,
): Promise<{ duration_ms?: number; width?: number; height?: number }> {
  const element = probeElementFor({ content_type: (file as File).type,
                                    b2_key: (file as File).name });
  if (!element) return {};
  try {
    const meta = await probeMediaMeta(file, { element });
    if (!meta) return {};
    return {
      ...(meta.durationMs != null ? { duration_ms: meta.durationMs } : {}),
      ...(meta.width != null ? { width: meta.width } : {}),
      ...(meta.height != null ? { height: meta.height } : {}),
    };
  } catch {
    return {};
  }
}

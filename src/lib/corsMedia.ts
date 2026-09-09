// A CORS-READABLE URL for a media asset, on a build where the host will not
// approve our origin.
//
// WHY THIS EXISTS. `MediaElementAudioSourceNode` outputs SILENCE — not an
// error — when it is built from an element whose bytes scripts may not read.
// So the timeline's audio effects need the media host to CORS-approve the
// page's origin. Measured against the live bucket:
//
//   http://localhost:5173    (tauri dev)        -> Access-Control-Allow-Origin
//   http://tauri.localhost   (packaged Windows) -> Access-Control-Allow-Origin
//   tauri://localhost        (packaged macOS)   -> NONE
//
// and that last one cannot be fixed at the bucket: B2 accepts only `*`,
// `https`, or `http(s)://host[:port]` as an origin, so a custom scheme is
// rejected by its API outright. Nor can the app move off the scheme — Tauri
// hard-wires macOS/iOS/Linux to `<scheme>://localhost` (tauri/src/app.rs), and
// `useHttpsScheme` is Windows/Android only.
//
// THE WAY OUT IS TO NOT ASK THE WEBVIEW. A request made from Rust is not bound
// by the webview's CORS policy — the same reason a local ComfyUI is reachable
// at all — so the bytes come back through `httpFetch` and become a `blob:`
// URL, which is same-origin by construction and therefore readable. The bucket
// is on the capability allow-list for exactly this.
//
// THE COST IS MEMORY: a blob is the whole file, so this is deliberately used
// ONLY for audio clips that actually carry an effect, is size-capped, and
// holds a handful at a time. A streaming custom-protocol handler is the
// upgrade if that ever binds — it would serve video too.
// `.ts` deliberately: `node --test` strips types but does NOT resolve an
// extensionless relative import, and this module is now covered by a test.
import { httpFetch, isDesktop, isLocalMediaUrl } from "./desktop.ts";

/** Refuse to pull more than this into memory for one clip. A dialogue stem or
 *  a music bed is a few tens of MB; anything far past that is a video-sized
 *  file that has no business on an audio lane, and dropping the effect is
 *  better than a hung app. */
const MAX_BYTES = 96 * 1024 * 1024;
/** Total blob budget. The budget is enforced by REFUSING new blobs, never by
 *  revoking held ones: every audio element on the timeline is mounted for the
 *  life of the editor, so any blob in this cache may be some element's live
 *  `src` — and revoking under a live element is a repeating
 *  `WebKitBlobResource error 1` in the console plus a clip that silently
 *  stops playing (a real cut put ~15 effect-carrying clips through what used
 *  to be a 6-slot LRU here, and the eviction churn was exactly that). A clip
 *  refused for budget plays plainly with its effects off, which is the
 *  documented degradation for the over-size case too. */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
/** How long an unreferenced blob lingers before it is revoked. The player
 *  re-renders its elements onto new URLs within a frame of the effect set
 *  changing; the grace covers transient flaps so a blob is never pulled out
 *  from under an element that still names it. */
const RELEASE_GRACE_MS = 3000;

const cache = new Map<string, { obj: string; size: number }>(); // source URL -> blob
const inflight = new Map<string, Promise<string | null>>();
const refused = new Set<string>();
const pendingRelease = new Map<string, ReturnType<typeof setTimeout>>();
let lastRetained: Set<string> | null = null;

const totalBytes = () => {
  let n = 0;
  for (const e of cache.values()) n += e.size;
  return n;
};

/** True where the webview cannot read the media host directly and Rust can. */
export const needsCorsProxy = () => isDesktop();

/** The blob URL for `url` if it is already resolved. Synchronous, for render. */
export const cachedCorsUrl = (url: string): string | null => cache.get(url)?.obj ?? null;

/** True when we tried and cannot — so the caller stops asking and reports it. */
export const corsProxyRefused = (url: string): boolean => refused.has(url);

/** Tell the cache which source URLs are CURRENTLY in use, so everything else
 *  can be let go. This — not an LRU inside ensureCorsUrl — is how blobs are
 *  freed: only the consumer knows which elements still name one, and it calls
 *  this with the full set whenever that set changes. A blob that leaves the
 *  set is revoked after a grace window; one that comes back in time is kept. */
export function retainCorsUrls(inUse: Set<string>): void {
  lastRetained = inUse;
  for (const url of inUse) {
    const t = pendingRelease.get(url);
    if (t) { clearTimeout(t); pendingRelease.delete(url); }
  }
  for (const url of cache.keys()) {
    if (inUse.has(url) || pendingRelease.has(url)) continue;
    pendingRelease.set(url, setTimeout(() => {
      pendingRelease.delete(url);
      if (lastRetained?.has(url)) return;   // came back into use meanwhile
      const dead = cache.get(url);
      cache.delete(url);
      if (dead) URL.revokeObjectURL(dead.obj);
    }, RELEASE_GRACE_MS));
  }
}

/** Fetch `url` through Rust and return a same-origin blob URL for it.
 *
 *  Resolves null when it cannot: too big, the request failed, or this is the
 *  web build (where the bucket already approves the origin and the plain URL
 *  is correct). Never throws — a failed effect must not take the clip's
 *  ordinary playback down with it. */
export function ensureCorsUrl(url: string, bytes: number | null): Promise<string | null> {
  if (!needsCorsProxy()) return Promise.resolve(null);
  // A LOCAL PROJECT'S MEDIA IS ALREADY READABLE, so proxying it would be work
  // that also fails. Tauri's asset protocol answers with the window's own
  // origin in `Access-Control-Allow-Origin` (tauri/src/protocol/asset.rs), and
  // `httpFetch` could not fetch an `asset://` URL anyway — it is not on the
  // capability allow-list, which is http hosts only. Returning null here means
  // "use the URL you have", which is the correct answer rather than a
  // fallback: the effects rack works on local media with no proxy at all.
  if (!/^https?:/i.test(url)) return Promise.resolve(null);
  // A local project's own media, served by this machine with
  // `Access-Control-Allow-Origin: *` on it. It is http, so the test above
  // lets it through, and it needs no proxy at all — the whole reason this
  // module exists is a bucket that sends no such header.
  //
  // NULL HERE PUTS THE OBLIGATION ON THE CALLER, and it is not optional: the
  // host approving the origin is only half of it, and an element that loads
  // without `crossOrigin` is opaque whatever the host said — its
  // MediaElementAudioSourceNode then outputs ZEROES rather than failing.
  // `PreviewPlayer` loads these in CORS mode itself; see the measurement
  // there.
  if (isLocalMediaUrl(url)) return Promise.resolve(null);
  const hit = cache.get(url);
  if (hit) return Promise.resolve(hit.obj);
  if (refused.has(url)) return Promise.resolve(null);
  const busy = inflight.get(url);
  if (busy) return busy;

  if (bytes != null && bytes > MAX_BYTES) {
    refused.add(url);
    console.warn(`[corsMedia] ${Math.round(bytes / 1e6)}MB is over the ${MAX_BYTES / 1e6}MB cap — effects off for this clip`);
    return Promise.resolve(null);
  }

  const job = (async () => {
    try {
      const res = await httpFetch(url);
      if (!("blob" in res) || !res.ok) throw new Error(`status ${(res as Response).status}`);
      const blob = await (res as Response).blob();
      if (blob.size > MAX_BYTES) throw new Error(`${Math.round(blob.size / 1e6)}MB over cap`);
      // Over the TOTAL budget: this clip's effects stay off rather than any
      // held blob being revoked — see MAX_TOTAL_BYTES for why revocation is
      // never the answer here.
      if (totalBytes() + blob.size > MAX_TOTAL_BYTES) {
        throw new Error(
          `${Math.round((totalBytes() + blob.size) / 1e6)}MB total would pass the ` +
          `${MAX_TOTAL_BYTES / 1e6}MB blob budget — too many effect-carrying clips at once`);
      }
      const obj = URL.createObjectURL(blob);
      cache.set(url, { obj, size: blob.size });
      return obj;
    } catch (e) {
      refused.add(url);
      console.warn("[corsMedia] could not proxy media for effects:", e);
      return null;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, job);
  return job;
}

/** Drop everything. Only for tests and teardown — a live element pointing at a
 *  revoked blob stops playing. */
export function _resetCorsMedia(): void {
  for (const e of cache.values()) URL.revokeObjectURL(e.obj);
  for (const t of pendingRelease.values()) clearTimeout(t);
  cache.clear(); inflight.clear(); refused.clear(); pendingRelease.clear();
  lastRetained = null;
}

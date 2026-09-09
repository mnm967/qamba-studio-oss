// DEV-ONLY PLAYBACK DIAGNOSTIC. Ships nothing.
//
// WKWebView has no CDP and no headless inspector, so what the desktop build's
// media elements are doing during playback can only be seen by having the
// page report it. The August/September measurements in PreviewPlayer came out
// of a Rust plugin that appended to /tmp — which then shipped in 0.1.0 by
// accident and was removed. This is the same idea kept where it cannot leak:
// every call site is `if (import.meta.env.DEV) diag(...)`, which a production
// build turns into `if (false)` and drops, and this module's own work is behind
// the same flag. It reports to the Vite dev server (`/api/diag` in
// dev-server-api.js), which appends to a file this side can read. Under
// `tauri dev` the page origin IS the dev server, so a relative fetch reaches it
// and `connect-src 'self'` allows it.
//
// What it records, one line per event, all on ONE clock (ms since start):
//   GAP <ms>         a requestAnimationFrame gap over GAP_MS — a main-thread
//                    stall, whatever caused it (WebKit has no `longtask`).
//   CENSUS ...       how many <video>/<audio> exist, how many are the timeline
//                    player's own layers and how many are thumbnails elsewhere,
//                    and how many are loading/loaded. Every element here is a
//                    media player on WebKit, whether or not it is playing.
//   MOUNT/PLAY/PLAYING/WAITING/STALLED/SEEKING/SEEKED/RATECHANGE/...  DOM
//                    media events with the element's state at that instant.
//   TICK             once a second, every non-paused element's state.
//   SLOTS/PLAY/PLAYED/SEEK/RATE/STALL/SCRUB  the player's own decisions,
//                    from PreviewPlayer.
//   SAVE/INVAL       the local plane's writes and refetch fan-outs.
const ENABLED = !!(import.meta.env?.DEV) && typeof window !== "undefined";
const GAP_MS = 40;

let buf: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let dead = false;
const t0 = typeof performance !== "undefined" ? performance.now() : 0;
/** One tag per page load, so two pages reporting into one file (a browser tab
 *  beside the desktop window, say) can be told apart. */
const SID = Math.random().toString(36).slice(2, 6);
const stamp = () => `${SID} ${String(Math.round(performance.now() - t0)).padStart(7)}`;

export function diag(line: string): void {
  if (!ENABLED || dead) return;
  buf.push(`${stamp()} ${line}`);
  if (!timer) timer = setTimeout(flush, 400);
}

async function flush(): Promise<void> {
  timer = null;
  if (!buf.length) return;
  const lines = buf; buf = [];
  try {
    const r = await fetch("/api/diag", {
      method: "POST", headers: { "content-type": "text/plain" }, body: lines.join("\n") + "\n",
    });
    // No endpoint (a plain browser tab against a production server, say):
    // stop collecting rather than buffering forever.
    if (r.status === 404 || r.status === 405) dead = true;
  } catch { dead = true; }
}

const RS = ["NOTHING", "METADATA", "CURRENT", "FUTURE", "ENOUGH"];
const NS = ["EMPTY", "IDLE", "LOADING", "NO_SOURCE"];
const EVENTS = ["loadstart", "loadedmetadata", "canplay", "canplaythrough", "play", "playing", "pause",
  "waiting", "stalled", "suspend", "seeking", "seeked", "emptied", "abort", "error", "ended",
  "ratechange", "volumechange"];

const nameOf = (e: HTMLMediaElement) =>
  (e.currentSrc || e.src || "(none)").split("/").pop()!.split("?")[0].slice(0, 28);
const whereOf = (e: HTMLMediaElement) => (e.closest(".tl-preview") ? "player" : "thumb");
const stateOf = (e: HTMLMediaElement) => {
  const buf = e.buffered.length ? e.buffered.end(e.buffered.length - 1).toFixed(2) : "0";
  return `${e.tagName[0]}:${(e.dataset.clip ?? "").slice(0, 8)} ${whereOf(e)} ${nameOf(e)} rs=${RS[e.readyState]} `
    + `net=${NS[e.networkState]} ${e.paused ? "PAUSED" : "play"} rate=${e.playbackRate} `
    + `${e.muted ? "MUTED" : "vol=" + e.volume.toFixed(2)} t=${e.currentTime.toFixed(3)} buf=${buf} `
    + `pre=${e.preload}${e.error ? " ERR" + e.error.code : ""}`;
};

const seen = new WeakSet<HTMLMediaElement>();
function watch(e: HTMLMediaElement) {
  if (seen.has(e)) return;
  seen.add(e);
  diag(`MOUNT ${stateOf(e)}`);
  for (const ev of EVENTS) {
    e.addEventListener(ev, () => diag(`${ev.toUpperCase().padEnd(14)} ${stateOf(e)}`));
  }
}

let started = false;
/** Start the watchdog, the census and the element watcher. Idempotent. */
export function startPlaybackDiag(): void {
  if (!ENABLED || started) return;
  started = true;
  diag(`===== session start origin=${location.origin} ua=${navigator.userAgent} hz=? =====`);
  document.addEventListener("visibilitychange", () => diag(`VISIBILITY ${document.visibilityState}`));

  // Main-thread stall watchdog. rAF only fires while the page is visible, so a
  // gap here is either a long task or the compositor being throttled; both are
  // what "laggy" looks like from inside the page.
  let prev = 0;
  const step = (t: number) => {
    if (prev && t - prev > GAP_MS) diag(`GAP ${Math.round(t - prev)}ms`);
    prev = t;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);

  const scan = () => document.querySelectorAll<HTMLMediaElement>("video,audio").forEach(watch);
  scan();
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });

  let lastCensus = "";
  let n = 0;
  setInterval(() => {
    const els = [...document.querySelectorAll<HTMLMediaElement>("video,audio")];
    const c = { v: 0, a: 0, player: 0, thumb: 0, loading: 0, loaded: 0, playing: 0 };
    for (const e of els) {
      if (e.tagName === "VIDEO") c.v++; else c.a++;
      if (whereOf(e) === "player") c.player++; else c.thumb++;
      if (e.networkState === 2) c.loading++;
      if (e.readyState >= 1) c.loaded++;
      if (!e.paused) c.playing++;
    }
    const line = `CENSUS video=${c.v} audio=${c.a} player=${c.player} thumbs=${c.thumb} loading=${c.loading} loaded=${c.loaded} playing=${c.playing}`;
    if (line !== lastCensus || ++n % 10 === 0) { lastCensus = line; diag(line); }
    const playing = els.filter((e) => !e.paused);
    if (playing.length) diag(`TICK ${playing.map(stateOf).join(" || ")}`);
  }, 1000);

  // DEV REMOTE. WKWebView cannot be driven from outside (no CDP, and a bare
  // `tauri dev` binary has no bundle id for accessibility tools to address),
  // so the page asks the dev server for commands instead. The command file is
  // written by whoever is at the shell; the server only ever READS it, so a
  // client that can reach the dev server on the LAN can log lines here and
  // nothing more. Dev-only like everything else in this module.
  // Desktop webview only: a browser tab beside it can be driven directly, and
  // two pages draining one queue would each get half of every sequence.
  if ("__TAURI__" in window) setInterval(() => void pollCommands(), 1500);
}

type Cmd = Record<string, unknown> & { op: string };
async function pollCommands(): Promise<void> {
  if (dead) return;
  let cmds: Cmd[] = [];
  try {
    const r = await fetch("/api/diag/cmd", { cache: "no-store" });
    if (r.status !== 200) return;
    cmds = (await r.json()) as Cmd[];
  } catch { return; }
  for (const c of cmds) await runCommand(c);
}

async function runCommand(c: Cmd): Promise<void> {
  const op = String(c.op);
  try {
    switch (op) {
      case "goto":
        // react-router's BrowserRouter listens to popstate and re-reads the
        // location, so this is a client-side navigation, not a reload.
        history.pushState({}, "", String(c.path));
        dispatchEvent(new PopStateEvent("popstate"));
        break;
      case "reload": location.reload(); break;
      case "ls": localStorage.setItem(String(c.key), String(c.value)); break;
      case "play": (await import("../stores/usePlaybackStore")).usePlaybackStore.getState().play(); break;
      case "pause": (await import("../stores/usePlaybackStore")).usePlaybackStore.getState().pause(); break;
      case "seek": (await import("../stores/usePlaybackStore")).usePlaybackStore.getState().seek(Number(c.ms)); break;
      case "ws": {
        const st = (await import("../stores/useWorkspaceStore")).useWorkspaceStore.getState() as unknown as
          { set: (k: string, v: unknown) => void };
        st.set(String(c.key), c.value);
        break;
      }
      case "info": {
        const pb = (await import("../stores/usePlaybackStore")).usePlaybackStore.getState();
        diag(`INFO path=${location.pathname} vis=${document.visibilityState} playing=${pb.playing} held=${pb.isHeld()} now=${Math.round(pb.nowMs())} dur=${pb.durationMs} `
          + `video=${document.querySelectorAll("video").length} audio=${document.querySelectorAll("audio").length}`);
        break;
      }
      case "eval": {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const out = await (new Function(String(c.js)) as () => unknown)();
        diag(`CMD eval -> ${String(JSON.stringify(out) ?? out).slice(0, 400)}`);
        break;
      }
      default: throw new Error(`unknown op ${op}`);
    }
    diag(`CMD ${op} ok ${JSON.stringify(c).slice(0, 200)}`);
  } catch (e) {
    diag(`CMD ${op} ERR ${String(e).slice(0, 300)}`);
  }
}

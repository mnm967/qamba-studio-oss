// Is this the desktop shell, and what can it do that a browser tab cannot.
//
// THE BRIDGE IS THE GLOBAL, NOT THE NPM PACKAGE. Tauri v2 ships an
// `@tauri-apps/api` module, and importing it here would put it in the WEB
// bundle too — for a build where every one of its calls throws. `withGlobalTauri`
// exposes the same surface on `window.__TAURI__` inside the desktop webview and
// nowhere else, so the web build carries none of it and the check for "am I
// desktop" is the same object that provides the capability. That also keeps
// invariant #4 honest: nothing new ships to the browser.
//
// EVERY EXPORT FALLS BACK. A component must never have to ask which build it is
// in before calling something — `detectHardware()` on the web returns null,
// `openExternal()` uses window.open. The one thing that does NOT fall back is
// the local engine (comfyLocal.ts): a browser tab talking to ComfyUI would
// break invariant #1, so that module refuses rather than degrades.

interface TauriHttpResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface TauriGlobal {
  core: {
    invoke<T = unknown>(
      cmd: string,
      /** Tauri sends an ArrayBuffer view as a RAW body rather than as named
       *  JSON arguments — see `invokeBytes`. */
      args?: Record<string, unknown> | Uint8Array,
      opts?: { headers?: Record<string, string> },
    ): Promise<T>;
  };
  event?: {
    listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void>;
  };
  http?: { fetch(input: string, init?: RequestInit): Promise<TauriHttpResponse> };
  /** set only by `desktop.mock.ts` — a fake bridge must be able to say so, or
   *  code that reasons about the TRANSPORT (see `hasRustHttp`) believes it is
   *  talking to Rust when it is talking to the browser. */
  mock?: boolean;
  opener?: { openUrl(url: string): Promise<void> };
  /** The core window API. `withGlobalTauri` ships the whole bundle, so it is
   *  there in the real shell — but OPTIONAL, because the mock bridge does not
   *  fake it and nothing may depend on it. `titlebar.ts` is the one caller. */
  window?: { getCurrentWindow(): { isFullscreen(): Promise<boolean> } };
}

declare global {
  interface Window { __TAURI__?: TauriGlobal }
}

const tauri = (): TauriGlobal | null =>
  (typeof window !== "undefined" && window.__TAURI__) || null;

/** True inside the Tauri webview. Cheap, synchronous, safe during render. */
export const isDesktop = (): boolean => tauri() !== null;

/** Invoke a Rust command. Returns null on the web rather than throwing, so a
 *  caller can treat "no desktop" and "the probe found nothing" alike. */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  const t = tauri();
  if (!t) return null;
  try {
    return await t.core.invoke<T>(cmd, args);
  } catch (e) {
    console.error(`[desktop] ${cmd} failed`, e);
    return null;
  }
}

/** Invoke a Rust command and let it THROW.
 *
 *  `invoke` above swallows the error and returns null, which is right for a
 *  probe — "no desktop" and "found nothing" really are the same answer there.
 *  It is wrong wherever the error IS the answer. Sign-in is the case: a
 *  refused invite comes back from `oauth_wait` as the provider's own
 *  `error_description`, and swallowing it would replace "that address is not
 *  on the studio invite list" with a blank failure the user cannot act on. */
export async function invokeStrict<T>(
  cmd: string, args?: Record<string, unknown>,
): Promise<T> {
  const t = tauri();
  if (!t) throw new Error(`${cmd} is only available in the desktop app`);
  return await t.core.invoke<T>(cmd, args);
}

/**
 * Invoke with a RAW BODY instead of named JSON arguments.
 *
 * Tauri's IPC decides on the content type from the payload itself: an
 * `ArrayBuffer`, a view of one, or an array is sent as
 * `application/octet-stream` and arrives in Rust as `InvokeBody::Raw`, where
 * anything else is `JSON.stringify`d and `serde_json`-parsed. So a large
 * document — `project.json` is 11MB on a real project — costs a full escape
 * on the way out (every quote doubling it), a parse on the way in, and both
 * of them on the app's MAIN thread, which is the thread also serving media to
 * the player. As bytes it is a memcpy at each end.
 *
 * A raw body has no room for named arguments, so anything the command needs
 * besides the bytes travels in a HEADER. Values must be legal header values —
 * ids and flags, not payloads.
 *
 * THROWS on the desktop, like `invokeStrict`: every caller is a write, and a
 * write that failed must never look like one that landed.
 */
export async function invokeBytes<T>(
  cmd: string, body: Uint8Array, headers?: Record<string, string>,
): Promise<T> {
  const t = tauri();
  if (!t) throw new Error(`${cmd} is only available in the desktop app`);
  return await t.core.invoke<T>(cmd, body, headers ? { headers } : undefined);
}

/**
 * Subscribe to a Rust-side event. Returns an unlisten function, or null on the
 * web — a caller stores it and calls it on unmount, and `?.()` covers both.
 *
 * This is the half a polled command cannot do: `pip install` prints for
 * minutes with nothing to poll, so install progress is PUSHED, and a bar that
 * only moves when someone asks is what makes an install feel hung.
 */
export async function listen<T>(
  event: string, cb: (payload: T) => void,
): Promise<(() => void) | null> {
  const t = tauri();
  if (!t?.event) return null;
  try {
    return await t.event.listen<T>(event, (e) => cb(e.payload));
  } catch (e) {
    console.error(`[desktop] listen(${event}) failed`, e);
    return null;
  }
}

/**
 * A fetch that is not subject to the webview's CORS policy, because it runs in
 * Rust. This is what makes the local engine reachable at all: ComfyUI only
 * sends `Access-Control-Allow-Origin` when it was started with
 * `--enable-cors-header`, which a user's own install almost never is, so a
 * plain browser fetch to :8188 fails before it leaves the page.
 *
 * On the web it degrades to the ordinary fetch, which is right for the one
 * caller that works in both (Civitai search does send CORS headers).
 */
/**
 * True when a request would go through RUST rather than the webview.
 *
 * This is not the same question as `isDesktop()`, and the difference matters
 * to anything sending an `Authorization` header cross-origin: Rust is not
 * subject to CORS, a webview fetch is. The dev-only mock bridge reports a
 * desktop with an `http` that DELEGATES TO THE BROWSER, so a caller that
 * assumed "desktop means no CORS" is wrong exactly there — measured against
 * Civitai's live API: an anonymous search answers 200 and the same search with
 * `authorization` never leaves the page.
 */
export const hasRustHttp = (): boolean => !!tauri()?.http && !tauri()?.mock;

/** True where the WEBVIEW has to do the fetching, because Rust cannot.
 *
 *  The Rust transport speaks **http and https and nothing else** — every other
 *  scheme returns `SchemeNotSupport`, read off the plugin's own match arms
 *  (tauri-plugin-http 2.5.9, `commands.rs`). A LOCAL PROJECT'S MEDIA is
 *  exactly that: `convertFileSrc` builds `asset://localhost/<path>` on macOS
 *  and Linux, and `http://asset.localhost/<path>` on Windows — which IS http,
 *  and still not something Rust may fetch, because the capability allow-list
 *  names remote hosts only.
 *
 *  So this is not a fallback, it is the only transport that works, and it is
 *  the exact mirror of the engine and the CDN, where Rust is the only one that
 *  works (a stock ComfyUI sends no `Access-Control-Allow-Origin` and B2 will
 *  not approve `tauri://localhost`). The webview reads every scheme below
 *  natively: Tauri's asset protocol answers with the window's own origin in
 *  `Access-Control-Allow-Origin`, and blob: and data: are same-origin by
 *  construction. `tauri.conf.json`'s `connect-src` already names `asset:` and
 *  `http://asset.localhost` for this.
 *
 *  WHAT IT COST TO BE MISSING: `localRender.stage()` resolves a reference to
 *  whatever `mediaUrl()` gives it and hands that to `httpFetch`, so a local
 *  render of a local project's own reference died on `scheme asset not
 *  supported` before the engine was ever asked — a red banner on Generate,
 *  with the picture sitting in the library the whole time. */
/**
 * Where this machine serves a LOCAL project's media from, once it is known.
 *
 * `http://127.0.0.1:<port>/<token>`, set by `bootLocalPlane` and null on the
 * web and before the first local project is opened. Two things ask: the
 * transport (below) and `corsMedia`, and both would otherwise get this wrong
 * in the same way — it LOOKS like an ordinary remote http URL and is neither
 * remote nor in need of a proxy.
 */
let mediaOrigin: string | null = null;

export function setLocalMediaOrigin(origin: string | null): void {
  mediaOrigin = origin;
}

/** Is this one of our own loopback media URLs? */
export function isLocalMediaUrl(url: string): boolean {
  return !!mediaOrigin && url.startsWith(mediaOrigin);
}

export function needsWebviewFetch(url: string): boolean {
  const u = url.trim();
  if (/^(asset|blob|data|file):/i.test(u)) return true;
  // Our own media server. It sends `Access-Control-Allow-Origin: *`, so the
  // webview can read it directly — and Rust CANNOT, because loopback is not on
  // the capability allow-list and must not be widened to all of it: 127.0.0.1
  // is also where the user's ComfyUI lives, and that one genuinely needs the
  // CORS-free transport.
  if (isLocalMediaUrl(u)) return true;
  // Tauri's own asset protocol as it is spelled on Windows. Matched on the
  // HOST rather than the prefix so a real server that merely starts with the
  // same letters (`asset.localhost.example.com`) still goes through Rust.
  try {
    return new URL(u).hostname.toLowerCase() === "asset.localhost";
  } catch {
    return false;   // relative or unparseable: the webview's problem either way
  }
}

export function httpFetch(url: string, init?: RequestInit): Promise<Response | TauriHttpResponse> {
  const t = tauri();
  if (t?.http && !needsWebviewFetch(url)) return t.http.fetch(url, init);
  return fetch(url, init);
}

/* ── hardware ───────────────────────────────────────────────────────────── */

export type GpuVendor = "nvidia" | "apple" | "amd" | "intel" | "unknown";

export interface GpuInfo {
  name: string;
  vendor: GpuVendor;
  /** dedicated VRAM, or unified memory on Apple Silicon, in MB */
  vram_mb: number;
  /** true when `vram_mb` is system memory the GPU shares rather than its own —
   *  the difference decides whether a 21GB checkpoint is a plan or a swap storm */
  unified: boolean;
}

export interface HardwareProfile {
  os: string;
  arch: string;
  cpu: string;
  cores: number;
  ram_mb: number;
  free_disk_mb: number;
  gpus: GpuInfo[];
  /** ComfyUI installs found on disk, in the order they were probed */
  comfy_paths: string[];
}

export interface EngineStatus {
  installed: boolean;
  python: string | null;
  comfy_dir: string | null;
  root: string;
  checkpoints: string[];
  loras: string[];
  /** every model file present, across every model directory, by bare filename */
  files: string[];
  /** the same files with their size in MB — "can this machine run that graph"
   *  is a question about bytes, and a filename only estimates them */
  file_mb: Record<string, number>;
  /** half-finished downloads, by FINAL filename, with the MB already fetched */
  partial_mb: Record<string, number>;
  /** which catalogue row each of those was started for, when it is known */
  partial_owner: Record<string, string>;
  /** every model file grouped by its directory — `checkpoints` and `loras`
   *  above are two of these. "Is there anything to render with" is a question
   *  about checkpoints OR diffusion_models, never checkpoints alone. */
  by_dir: Record<string, string[]>;
  /** custom node packs present AND usable, by directory name. A pack whose
   *  dependencies would not install is excluded — see `nodes_broken`. */
  nodes: string[];
  /** Packs on disk whose dependencies were refused under the engine's own
   *  constraints (a dependency wanting a different PyTorch, which pinning
   *  turns into a refusal rather than a silently downgraded engine). Separate
   *  from absent because the fix is "reinstall the engine", not "download it".
   *  Absent on a build older than the field. */
  nodes_broken?: string[];
  running: boolean;
  port: number;
  /** The ComfyUI directory every listing above was read from, and where a
   *  download lands. Ours by default; the user's own when they linked one.
   *  Reported because "installed" and "has weights" are no longer the same
   *  question — a linked setup has a full model tree and `installed: false`. */
  models_dir: string;
  /** true when `models_dir` is the user's own ComfyUI rather than ours */
  models_linked: boolean;
  /** the engine's own Python is on disk — the PLANNING half of the utilities
   *  install. Not the same question as `installed`, which also wants ComfyUI:
   *  a machine that took "Utilities only", or one that brought its own
   *  ComfyUI, is `planner: true, installed: false`. */
  planner: boolean;
  /** ffmpeg AND ffprobe are reachable by a job we spawn — ours, or a pair the
   *  machine already had. A GUI-launched app does not inherit Homebrew's
   *  directory, so this is deliberately not "is ffmpeg on the app's PATH". */
  ffmpeg: boolean;
  /** ...and true only when they are the pair WE installed, so the UI can say
   *  whose is in charge rather than claiming an install it skipped. */
  ffmpeg_ours: boolean;
}

export const engineStatus = () => invoke<EngineStatus>("engine_status");

/** Point the weight catalogue at a ComfyUI of the user's own — or, with null,
 *  back at ours. Resolves to the directory now in use.
 *
 *  `invokeStrict`, NOT `invoke`: the refusal IS the answer here. Plain
 *  `invoke` swallows it and returns null, which the caller cannot tell from a
 *  successful link — and it does not fail loudly, it fails POLITELY: the panel
 *  closes, the field clears, and the directory is quietly unchanged. Measured
 *  in the harness with a deliberately wrong path, which came back looking
 *  exactly like a success. */
export const setLinkedComfy = (dir: string | null) =>
  invokeStrict<string>("set_linked_comfy", { dir });

/** Open the native folder picker. Resolves to the chosen path, or null when
 *  the user cancels — a cancel is a NORMAL outcome, not a failure, so this is
 *  the one place `invoke`'s swallow-and-return-null is the right shape.
 *
 *  It does not link what it returns: `setLinkedComfy` validates, so a folder
 *  picked here and a path typed by hand meet the same bar. */
export const pickComfyDir = () => invoke<string>("pick_comfy_dir");

/** One download currently in flight, as the Rust side sees it. */
export interface ActiveDownload {
  /** the FILENAME — downloads are keyed per file, not per model */
  id: string;
  received: number;
  total: number;
  dest: string;
  /** which catalogue row asked for it (`family/variant`, or an add-on id).
   *  A filename cannot answer that: the shared text encoder belongs to every
   *  variant in its family, so attributing by name marked all of them as
   *  downloading. `null` when nothing claimed it. */
  owner?: string | null;
}

/**
 * What is downloading right now.
 *
 * A download outlives the screen that started it — the Rust task keeps writing
 * after the engine modal unmounts — so the modal seeds itself from this on
 * mount instead of assuming that its own empty state means nothing is
 * happening. Without it, reopening the modal mid-download showed a Download
 * button for a file already 1.6GB in.
 */
export const activeDownloads = async (): Promise<ActiveDownload[]> =>
  (await invoke<ActiveDownload[]>("active_downloads")) ?? [];

/** The machine's own account of itself, or null in a browser. */
export const detectHardware = () => invoke<HardwareProfile>("detect_hardware");

/** Total usable VRAM for the biggest single model — the max over GPUs, since
 *  nothing here splits a checkpoint across cards. */
export function usableVramMb(p: HardwareProfile | null): number {
  if (!p?.gpus.length) return 0;
  return Math.max(...p.gpus.map((g) => g.vram_mb));
}

/**
 * How much of this machine a model may actually have, in GB.
 *
 * UNIFIED MEMORY IS NOT VRAM, which is the whole reason this is not just
 * `usableVramMb / 1024`: an Apple machine shares that 16GB with the OS and
 * everything else running, so ~60% is what a model can really take. Reading
 * the raw figure is how a 16GB M3 gets told an 11GB model fits.
 *
 * It lives here rather than inline in a screen because there are now two
 * callers — the ComfyUI catalogue and the LLM one — and two copies of a rule
 * like this is two answers about one machine. `usableVramMb` is left alone:
 * it is the raw probe, and this is the judgement made from it.
 */
export function machineBudgetGb(p: HardwareProfile | null): number {
  const gpu = p?.gpus[0];
  if (!gpu) return 0;
  return gpu.unified ? (gpu.vram_mb / 1024) * 0.6 : gpu.vram_mb / 1024;
}

/**
 * System RAM a render may take, in GB — the SECOND budget, and the one nothing
 * here used to ask about.
 *
 * The H3 tier benchmark made it unavoidable: ComfyUI answers a small graphics
 * card by streaming weights out of host memory, so the rungs that fit the
 * smallest cards are the ones that want the most RAM (23-43GB), and a machine
 * with a fine GPU and 16GB of RAM was oom-killed in 110 seconds. A wizard that
 * gates on VRAM alone promises exactly that user a render that cannot happen.
 *
 * `RAM_HEADROOM_GB` is left for the OS and whatever else is open. It is a
 * judgement, not a measurement — unlike the catalogue's `ram_gb` figures, which
 * were measured on an otherwise idle box and would therefore be met exactly at
 * the moment everything else on the machine was closed.
 */
const RAM_HEADROOM_GB = 4;
export function machineRamGb(p: HardwareProfile | null): number {
  if (!p?.ram_mb) return Infinity;   // unknown is not "none" — do not refuse on it
  return Math.max(0, p.ram_mb / 1024 - RAM_HEADROOM_GB);
}

/* ── what to recommend, and why ─────────────────────────────────────────── */

//
// THERE USED TO BE A SECOND LIST HERE. `MODEL_PRESETS` + `recommendPreset` were
// a coarse machine-to-plan mapping — four hand-written rows with their own VRAM
// and download figures — sitting beside `engineCatalog`, which answers the same
// question from measured data. Nothing in the UI ever called it (the wizard
// asks `bestFor`), and its numbers had gone from approximate to wrong: it
// offered "MiniMax H3 int8, 21GB download, 20GB VRAM" when the tier benchmark
// measured that set at 35GB of download and an 8GB floor, and it had no notion
// of system RAM at all, which is the axis that actually refuses machines.
//
// Two lists is the failure `FirstRunSetupModal` already documents one screen
// over — "two lists, one of them aspirational, and no way for a user to tell
// which number to believe". So the presets are gone and the catalogue is the
// only answer. The machine profiles that pinned them live on in
// `desktop.test.ts`, now pointed at `bestFor`.

/* ── misc bridges ───────────────────────────────────────────────────────── */

/** Open a URL in the user's real browser, not inside the app window. */
export interface StageResult {
  file: string;
  /** an edited copy was already there and was LEFT ALONE — the caller has to
   *  offer it rather than pretend it wrote one */
  kept: boolean;
}

/**
 * Write a workflow where ComfyUI's own browser lists it.
 *
 * Strict, because a refusal here (a name that is not a name, a document that
 * is not JSON) is the answer rather than something to fall back from — see
 * `invokeStrict`. `overwrite` is the explicit "start over from the template";
 * without it an edited copy is kept and reported.
 */
export async function stageComfyWorkflow(
  name: string, json: string, overwrite = false,
): Promise<StageResult> {
  return await invokeStrict<StageResult>("stage_comfy_workflow", { name, json, overwrite });
}

/** One workflow in ComfyUI's own folder. `ours` marks the ones this app
 *  staged, which is a provenance note and not a filter — a graph the user
 *  built in ComfyUI is just as importable. */
export interface StagedWorkflow {
  file: string;
  modified_ms: number;
  bytes: number;
  ours: boolean;
}

/** What is in ComfyUI's workflow folder, newest first. Empty off the desktop
 *  and empty when there is no folder yet — both are "nothing to import",
 *  which is a state and not a failure. */
export async function listStagedWorkflows(): Promise<StagedWorkflow[]> {
  return (await invoke<StagedWorkflow[]>("list_staged_workflows")) ?? [];
}

export async function readStagedWorkflow(file: string): Promise<string> {
  return await invokeStrict<string>("read_staged_workflow", { file });
}

export async function openExternal(url: string): Promise<void> {
  const t = tauri();
  if (t?.opener) { await t.opener.openUrl(url); return; }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Where the desktop build keeps engines and weights. */
export const appDataDir = () => invoke<string>("app_data_dir");

/* ── browser sign-in ────────────────────────────────────────────────────── */

/** Bind a loopback port for the OAuth redirect; returns the port. */
export const oauthStart = () => invokeStrict<number>("oauth_start");

/** Wait for the provider's redirect and resolve with the authorization code.
 *  Rejects with the provider's own message when the answer is a refusal. */
export const oauthWait = () => invokeStrict<string>("oauth_wait");

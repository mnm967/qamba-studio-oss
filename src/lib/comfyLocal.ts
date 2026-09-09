// The desktop build's direct line to a ComfyUI running on the user's own
// machine. Nothing else in the app may talk to a ComfyUI.
//
// HOW THIS DOES NOT BREAK INVARIANT #1. That invariant is about the SHARED
// POD: the web frontend never reaches the studio's $3.36/hr box, because all
// work there is a `jobs` row a worker claims. This module is a different plane
// — the user's own localhost engine, on their own hardware, spending their own
// electricity — and it is unreachable from the web build by construction:
// every entry point calls `requireDesktop()`, and the transport is Tauri's
// Rust-side fetch, which does not exist in a browser tab. A render queued for
// the pod still goes through Supabase exactly as before.
//
// WHY THE TRANSPORT MATTERS. ComfyUI only sends CORS headers when started with
// `--enable-cors-header`, which a normal install is not, so a browser fetch to
// :8188 fails in preflight before ComfyUI ever sees it. Going through Rust
// side-steps the webview's policy entirely — the same reason the pod's worker
// can poll it and the browser cannot.
import {
  httpFetch, invokeStrict, isDesktop, listStagedWorkflows, openExternal,
  readStagedWorkflow, stageComfyWorkflow,
} from "./desktop.ts";
import {
  comfyImportName, comfySourceUrl, findComfyImport, importWorkflow,
  type CustomWorkflow, type ImportResult,
} from "./db/customWorkflows.ts";
import { formatComfyLog } from "./comfyLog.ts";
import { apiToUi } from "./workflowAdapter.ts";
import type { ApiGraph, ObjectInfo, UiGraph } from "./workflowAdapter.ts";

export const DEFAULT_COMFY = "http://127.0.0.1:8188";

/**
 * Headers every request to the engine must carry.
 *
 * COMFYUI REFUSES A FOREIGN ORIGIN, and this is not a CORS problem — it is a
 * 403 from ComfyUI itself. `server.py`'s `origin_only_middleware` compares the
 * Origin header's domain against the Host header's and returns 403 on a
 * mismatch, to stop a random web page a user has open from driving their
 * render engine. The webview's origin is `http://localhost:5173` in dev and
 * `tauri://localhost` in production, so it never matches, and EVERY request
 * from the desktop app was refused — measured against a real ComfyUI 0.33:
 *
 *     (no Origin)            -> 200
 *     http://localhost:5177  -> 403
 *     tauri://localhost      -> 403
 *     http://127.0.0.1:8188  -> 200
 *
 * Sending the engine's own origin is what makes the request look local, which
 * it is. The alternative — starting ComfyUI with `--enable-cors-header` —
 * only works for an engine WE launched, and the common case is a ComfyUI the
 * user already runs. It also switches off the check for every page on the
 * machine rather than for us.
 *
 * SETTING IT TAKES A CARGO FEATURE. `Origin` is a forbidden header name, so
 * the webview strips it and substitutes its own before the plugin is reached —
 * this header does nothing unless `tauri-plugin-http` is built with
 * `unsafe-headers` (see src-tauri/Cargo.toml). Both halves are required and
 * neither works alone.
 *
 * This is invisible in testing against anything but a real ComfyUI: a stub
 * server does not implement the middleware, so the mock passed while the real
 * engine returned 403 on every call.
 */
const comfyHeaders = (base: string): Record<string, string> => {
  try {
    return { origin: new URL(base).origin, accept: "application/json" };
  } catch {
    return { accept: "application/json" };
  }
};

export class NotDesktopError extends Error {
  constructor() {
    super("A local ComfyUI is only reachable from the desktop app. In the browser, "
      + "renders queue as jobs for the studio cloud.");
    this.name = "NotDesktopError";
  }
}

function requireDesktop() {
  if (!isDesktop()) throw new NotDesktopError();
}

/** Read a response from either transport. Tauri's response object is
 *  fetch-shaped but is NOT a `Response`, so nothing may rely on instanceof. */
async function readJson(r: { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }) {
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`ComfyUI answered ${r.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return r.json();
}

export interface ComfyStatus {
  reachable: boolean;
  /** ComfyUI's own version string, when it reports one */
  version?: string;
  python?: string;
  device?: string;
  vram_total_mb?: number;
  vram_free_mb?: number;
  error?: string;
}

/**
 * Is an engine listening, and what is it.
 *
 * A REFUSED CONNECTION IS NOT "NO COMFYUI", and the worker learned this the
 * expensive way (CLAUDE.md: `_NODE_TTL_UNREACHABLE`) — ComfyUI takes minutes to
 * start listening, so a probe during startup reports absence for a box that is
 * merely booting. Callers get the distinction in `error` and should retry
 * rather than concluding anything.
 */
export async function pingComfy(base = DEFAULT_COMFY, timeoutMs = 2500): Promise<ComfyStatus> {
  if (!isDesktop()) return { reachable: false, error: "not the desktop app" };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await httpFetch(`${base}/system_stats`,
      { signal: ctl.signal, headers: comfyHeaders(base) });
    const d = await readJson(r) as {
      system?: { comfyui_version?: string; python_version?: string };
      devices?: { name?: string; vram_total?: number; vram_free?: number }[];
    };
    const dev = d.devices?.[0];
    return {
      reachable: true,
      version: d.system?.comfyui_version,
      python: d.system?.python_version?.split(" ")[0],
      device: dev?.name,
      vram_total_mb: dev?.vram_total ? Math.round(dev.vram_total / 1048576) : undefined,
      vram_free_mb: dev?.vram_free ? Math.round(dev.vram_free / 1048576) : undefined,
    };
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

/** The full node schema. Big (multi-MB) — fetch once and hold it; it is what
 *  makes `uiToApi` exact and what `validateGraph` checks an import against. */
export async function getObjectInfo(base = DEFAULT_COMFY): Promise<ObjectInfo> {
  requireDesktop();
  return await readJson(
    await httpFetch(`${base}/object_info`, { headers: comfyHeaders(base) })) as ObjectInfo;
}

/** Just the class names — the cheap half of the same question. */
export async function getInstalledNodes(base = DEFAULT_COMFY): Promise<Set<string>> {
  return new Set(Object.keys(await getObjectInfo(base)));
}

/**
 * Which files the engine has, keyed by the loader input that offers them.
 * ComfyUI publishes these as the combo options of each loader's widget, so
 * this is derived from the same document — no second endpoint, and no guessing
 * at the models directory layout.
 */
export function filesFromObjectInfo(oi: ObjectInfo): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  for (const spec of Object.values(oi)) {
    for (const group of [spec.input?.required, spec.input?.optional]) {
      for (const [name, entry] of Object.entries(group ?? {})) {
        if (!Array.isArray(entry) || !Array.isArray(entry[0])) continue;
        const opts = entry[0].filter((v): v is string => typeof v === "string");
        if (!opts.length) continue;
        const pool = (out[name] ??= new Set<string>());
        for (const o of opts) pool.add(o);
      }
    }
  }
  return out;
}

/* ── execution ──────────────────────────────────────────────────────────── */

export interface QueueResult {
  prompt_id: string;
  number: number;
  /** ComfyUI's own validation findings, when it refuses the graph */
  node_errors?: Record<string, unknown>;
}

/** A stable per-install client id, so progress events can be told apart. */
export function clientId(): string {
  const KEY = "qamba.comfy.client";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

/**
 * Submit a graph.
 *
 * A REFUSED GRAPH COMES BACK AS A 400 WITH THE REASON IN IT, and that reason
 * is the most useful thing in the whole import flow — it names the node and
 * the input ComfyUI could not accept. Throwing it away and reporting "render
 * failed" is what makes a broken workflow undiagnosable, so the error text is
 * the validation payload, verbatim.
 */
export async function submitPrompt(
  graph: ApiGraph, base = DEFAULT_COMFY, opts: { clientId?: string } = {},
): Promise<QueueResult> {
  requireDesktop();
  const r = await httpFetch(`${base}/prompt`, {
    method: "POST",
    headers: { ...comfyHeaders(base), "content-type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: opts.clientId ?? clientId() }),
  });
  if (!r.ok) {
    const raw = await r.text().catch(() => "");
    let detail = raw.slice(0, 800);
    try {
      const j = JSON.parse(raw) as { error?: { message?: string; details?: string };
                                     node_errors?: Record<string, { errors?: { message?: string }[] }> };
      const parts = [j.error?.message, j.error?.details].filter(Boolean);
      for (const [id, ne] of Object.entries(j.node_errors ?? {})) {
        for (const e of ne.errors ?? []) parts.push(`node #${id}: ${e.message}`);
      }
      if (parts.length) detail = parts.join(" · ");
    } catch { /* keep the raw body */ }
    throw new Error(`ComfyUI refused the graph (${r.status}) — ${detail}`);
  }
  return await r.json() as QueueResult;
}

export interface HistoryOutput {
  /** filename, subfolder and type, as ComfyUI reports them */
  filename: string;
  subfolder: string;
  type: string;
  node: string;
  /** a URL the webview can load directly */
  url: string;
}

/** What a finished prompt produced, as URLs the app can show. */
export async function getOutputHistory(
  promptId: string, base = DEFAULT_COMFY,
): Promise<{ done: boolean; outputs: HistoryOutput[]; error?: string }> {
  requireDesktop();
  const d = await readJson(await httpFetch(`${base}/history/${promptId}`,
    { headers: comfyHeaders(base) })) as Record<string, {
    status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
    outputs?: Record<string, Record<string, { filename: string; subfolder: string; type: string }[]>>;
  }>;
  const entry = d[promptId];
  if (!entry) return { done: false, outputs: [] };

  const outputs: HistoryOutput[] = [];
  for (const [node, byKind] of Object.entries(entry.outputs ?? {})) {
    for (const list of Object.values(byKind)) {
      if (!Array.isArray(list)) continue;
      for (const f of list) {
        if (!f?.filename) continue;
        const q = new URLSearchParams({
          filename: f.filename, subfolder: f.subfolder ?? "", type: f.type ?? "output",
        });
        outputs.push({ ...f, node, url: `${base}/view?${q}` });
      }
    }
  }
  return {
    done: entry.status?.completed ?? outputs.length > 0,
    outputs,
    error: entry.status?.status_str === "error" ? "the graph errored — see the ComfyUI log" : undefined,
  };
}

/** Poll until the prompt lands. ComfyUI pushes progress over a websocket, but
 *  polling is what the worker does too and it needs no socket lifecycle for a
 *  one-off validation render. */
export async function waitForPrompt(
  promptId: string, base = DEFAULT_COMFY,
  opts: { timeoutMs?: number; everyMs?: number; onTick?: (n: number) => void } = {},
): Promise<{ done: boolean; outputs: HistoryOutput[]; error?: string }> {
  const { timeoutMs = 600_000, everyMs = 1200 } = opts;
  const until = Date.now() + timeoutMs;
  let n = 0;
  for (;;) {
    const h = await getOutputHistory(promptId, base);
    if (h.done || h.error) return h;
    if (Date.now() > until) return { done: false, outputs: [], error: "timed out waiting for ComfyUI" };
    opts.onTick?.(++n);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** ComfyUI's own log, over HTTP.
 *
 *  WHY THIS EXISTS: `engine_log` reads `comfyui.log` out of OUR engine root,
 *  which only ever has anything in it for an engine THIS APP SPAWNED. Linking
 *  a ComfyUI you already run is a first-class setup here, and in that setup
 *  the log panel was permanently empty — so the one message the studio gives
 *  you for a failed graph ("see the ComfyUI log") pointed at a panel that
 *  structurally could not show one.
 *
 *  ComfyUI serves it itself at `/internal/logs/raw` (verified against a live
 *  0.33 engine: 200, `{"entries":[{"t","m"}]}`), so a linked engine needs no
 *  cooperation from us — just the origin header every other call here sends,
 *  and the Rust transport, because a stock ComfyUI answers with no
 *  `Access-Control-Allow-Origin`.
 *
 *  NOT used for our own child, deliberately: the file captures stdout from the
 *  moment the process starts, while this endpoint can only answer once the
 *  server is listening — and on a cold start that is a minute or two of
 *  exactly the output you want when something went wrong at boot.
 */
export async function comfyLog(base = DEFAULT_COMFY, lines = 60): Promise<string> {
  requireDesktop();
  const r = await httpFetch(`${base}/internal/logs/raw`, { headers: comfyHeaders(base) });
  if (!r.ok) throw new Error(`the engine would not hand over its log (${r.status})`);
  return formatComfyLog(await readJson(r), lines);
}

/** Interrupt whatever is rendering. */
export async function interrupt(base = DEFAULT_COMFY): Promise<void> {
  requireDesktop();
  await httpFetch(`${base}/interrupt`, { method: "POST", headers: comfyHeaders(base) });
}

/**
 * Open ComfyUI's own editor, in a window of this app's rather than a tab.
 *
 * WHY NOT AN IFRAME — the thing everyone reaches for first, and it cannot
 * work: `origin_only_middleware` returns **403 on `Sec-Fetch-Site:
 * cross-site`** before any other check, and that header rides every
 * cross-origin frame navigation. Measured here rather than reasoned about: the
 * frame fires `load`, paints white, and the two 403s sit in the network log
 * where nobody looks, while the same URL opens fine as a top-level page. A
 * top-level navigation carries `Sec-Fetch-Site: none` and everything inside is
 * same-origin, so a WINDOW needs no `--enable-cors-header` (which would only
 * ever help an engine we launched, not the one you linked) and no proxy.
 *
 * Falls back to the browser rather than failing: an older binary has no such
 * command, and "the button did nothing" is the worst outcome available. The
 * return value says which happened so a caller can word itself honestly.
 */
export async function openComfy(
  base = DEFAULT_COMFY, workflow?: string,
): Promise<"window" | "browser"> {
  if (isDesktop()) {
    try {
      await invokeStrict("open_comfy_window", { url: base, workflow: workflow ?? null });
      return "window";
    } catch {
      // A refusal here is loopback-only or an old build — either way the
      // browser can still show it.
    }
  }
  await openExternal(base);
  return "browser";
}

export interface EditInComfy {
  /** the filename it landed under, which is what ComfyUI's sidebar shows */
  file: string;
  warnings: string[];
  /** classes the engine had no schema for, so their values did not travel */
  unmapped: string[];
  /** true when the document was already in the editor's own format */
  native: boolean;
  /** true when it went to a window that was asked to open it; false when all
   *  we could do was put it in the browser, where the sidebar is the way in */
  opened: boolean;
  /** ComfyUI already had an EDITED copy of this one, so nothing was written
   *  and that copy is what opened. The conversion above describes what WOULD
   *  have been written, not what is on screen. */
  kept: boolean;
}

/**
 * Put a graph in front of ComfyUI's editor and open it.
 *
 * TWO SOURCES, AND ONLY ONE NEEDS CONVERTING. An imported workflow keeps the
 * author's own `ui_graph` — layout, groups and all — so it is staged verbatim.
 * Everything this repo ships is API format, which ComfyUI's browser opens as
 * an EMPTY CANVAS (measured), so it goes through `apiToUi` first.
 *
 * THE SCHEMA COMES FROM THE ENGINE THAT IS ABOUT TO OPEN IT, and that is not
 * incidental: `FALLBACK_WIDGETS` covers the classes `resolve.py`
 * parameterises, not every class in a graph, so an offline conversion loses
 * values from ordinary nodes like `BasicGuider` — measured across every
 * template in the repo, where NONE converts cleanly without a schema and
 * twelve do with one. Asking the live engine is also the honest thing: it is
 * the machine whose packs decide what the graph even means.
 *
 * It does NOT open the workflow directly, because nothing can: this frontend
 * has no `?workflow=` URL intent, and the keys that remember the open document
 * live in ITS origin's storage. What it does is put the file where the
 * Workflows sidebar lists it — one click, under a name that says where it came
 * from. The caller is expected to say so.
 */
export async function editInComfy(
  name: string, source: { ui?: UiGraph | null; api?: ApiGraph | null },
  opts: { fresh?: boolean } = {},
): Promise<EditInComfy> {
  requireDesktop();
  let doc: unknown = source.ui ?? null;
  let warnings: string[] = [];
  let unmapped: string[] = [];
  const native = !!doc;
  if (!doc) {
    if (!source.api) throw new Error("there is no graph to open");
    const info = await getObjectInfo();          // throws when the engine is down
    const r = apiToUi(source.api, info);
    doc = r.graph;
    warnings = r.warnings;
    unmapped = r.unmapped;
  }
  // NEVER OVER YOUR WORK. The filename is derived from the workflow, so a
  // second "Edit in ComfyUI" aims at the same file — and the first version of
  // this wrote unconditionally, which meant clicking twice rewrote it from the
  // template and took whatever ComfyUI had saved with it. An edited copy is
  // kept and OPENED instead, which is what a second click means anyway.
  const st = await stageComfyWorkflow(
    `Qamba - ${name.replace(/\.json$/, "")}`, JSON.stringify(doc), opts.fresh === true);
  // …and ASK IT TO OPEN, rather than leaving it in the sidebar. The window is
  // ours, so it can carry the one instruction ComfyUI's URL cannot.
  const how = await openComfy(DEFAULT_COMFY, st.file);
  return {
    file: st.file, warnings, unmapped, native,
    opened: how === "window", kept: st.kept,
  };
}

/**
 * Bring a workflow BACK from ComfyUI.
 *
 * The other half of `editInComfy`, and the reason that one stages a file
 * rather than handing over a blob: ComfyUI saves where it opened from, so the
 * edit lands back in `user/default/workflows/` and this reads it from there.
 * It also picks up anything the user built in ComfyUI from scratch — same
 * folder, same import.
 *
 * IT BECOMES A `custom_workflows` ROW, NEVER AN EDIT TO A TEMPLATE. That is
 * the rule this whole feature is shaped around: `resolve.py` parameterises the
 * bundled templates by matching `class_type`, which is safe only on graphs we
 * wrote — an edited one would still render and would silently stop taking the
 * prompt, the references or the LoRA stack. A user graph is driven by TAGGED
 * SLOTS instead (`resolve_custom.py` on the pod, `graphForJob` here), which is
 * exactly what `importWorkflow` produces. The templates on disk are untouched.
 *
 * A SECOND SAVE UPDATES THE SAME ROW rather than making another: saving twice
 * is how people work, and the id has to keep resolving for anything already
 * pointing at it. `status` goes back to draft with it, because the graph
 * changed and the last render proves nothing about this one.
 */
export async function importFromComfy(
  file: string, opts: { projectId?: string | null; baseModel?: string | null } = {},
): Promise<ImportResult & { replaced: CustomWorkflow | null }> {
  requireDesktop();
  const text = await readStagedWorkflow(file);
  let graph: unknown;
  try {
    graph = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not readable as a workflow: ${(e as Error).message}`);
  }
  // The schema makes the conversion exact rather than table-driven, and this
  // direction needs it for the same reason the other one does — a positional
  // `widgets_values` array means nothing without the class's own order.
  const objectInfo = await getObjectInfo().catch(() => undefined);
  const replaced = await findComfyImport(file);
  const r = await importWorkflow({
    name: comfyImportName(file),
    graph, objectInfo,
    source: "comfyui",
    sourceUrl: comfySourceUrl(file),
    projectId: opts.projectId ?? null,
    baseModel: opts.baseModel ?? null,
    replaceId: replaced?.id ?? null,
  });
  return { ...r, replaced };
}

/** What ComfyUI has saved, newest first. */
export const savedInComfy = listStagedWorkflows;

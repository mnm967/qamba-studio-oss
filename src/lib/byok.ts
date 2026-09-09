// BYOK at runtime: which keys this machine holds, and the one way to spend one.
//
// THE VALUE IS NEVER HERE. `secrets.rs` has no command that hands a key back,
// so this module cannot show one, log one, or put one in a job payload even by
// accident — the strongest version of that guarantee is the one where the
// value has no path into the webview at all. What crosses the bridge is a
// REQUEST: provider, url, method, headers, body, and Rust attaches the
// credential after checking the host belongs to that provider.
//
// SHARED MODULE-LEVEL, like `useLocalEngine`. The keys tab, the model pickers,
// the director's backend list and the composer all ask at once; a poller per
// consumer would mean four keychain probes a tick, and on macOS a keychain
// probe is the thing that can prompt.
//
// DESKTOP ONLY, and it DEGRADES rather than refuses. On the web every export
// here answers "no keys" — which is true, not a failure — so a picker can call
// `byokRows(catalog, keyedProviders())` unconditionally and get an empty list
// in the browser instead of every caller having to ask which build it is in.
import { invoke, invokeStrict, isDesktop } from "./desktop.ts";
import {
  BYOK_BASE, BYOK_HEADERS, providerById, type ByokProvider,
} from "./byokProviders.ts";
import {
  EMPTY_CONFIG, readConfig, writeConfig, type ByokConfig, type CustomModel,
} from "./byokCatalog.ts";

/** One provider's key, as the index knows it. Never the value. */
export interface ByokKey {
  provider: string;
  present: boolean;
  /** last four characters, so two of your own keys are tellable apart */
  tail: string;
  /** unix seconds */
  set_at: number;
  account: string | null;
  /** the index says a key exists and the keychain does not have it */
  orphaned: boolean;
}

export interface ByokState {
  keys: ByokKey[];
  config: ByokConfig;
  /** false until the first probe lands, so a picker can tell "no keys" from
   *  "not asked yet" — the same distinction `useLiveQuery`'s `loading` makes,
   *  and for the same reason: an empty list rendered as a settled answer is
   *  how a working key reads as missing for the first second. */
  loaded: boolean;
}

let state: ByokState = { keys: [], config: EMPTY_CONFIG, loaded: false };
const subs = new Set<(s: ByokState) => void>();

/** Snapshots are handed back BY REFERENCE and only ever replaced.
 *  `useSyncExternalStore` compares with Object.is on every render, so a
 *  snapshot rebuilt on read is "changed" every time — render, read, render,
 *  "Maximum update depth exceeded", and the tree unmounts. The storage sheet
 *  learned this the hard way; see `autoStateFor` in CLAUDE.md. */
export const byokSnapshot = (): ByokState => state;

export function subscribeByok(fn: (s: ByokState) => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

function publish(next: Partial<ByokState>) {
  state = { ...state, ...next };
  for (const fn of subs) fn(state);
}

/** Providers with a key on this machine. The set every picker filters on. */
export function keyedProviders(s: ByokState = state): Set<string> {
  return new Set(s.keys.filter((k) => k.present).map((k) => k.provider));
}

export const hasKey = (provider: string, s: ByokState = state): boolean =>
  s.keys.some((k) => k.provider === provider && k.present);

let inflight: Promise<void> | null = null;

/** Re-read the key index and the model config. */
export function refreshByok(): Promise<void> {
  if (!isDesktop()) {
    if (!state.loaded) publish({ keys: [], config: EMPTY_CONFIG, loaded: true });
    return Promise.resolve();
  }
  inflight ??= (async () => {
    try {
      const keys = (await invoke<ByokKey[]>("byok_status")) ?? [];
      publish({ keys, config: readConfig(), loaded: true });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/* ── writes ─────────────────────────────────────────────────────────────── */

/** Store a key. Throws with the keychain's own words — a refused write is the
 *  answer, not a null to be treated as "no desktop". */
export async function setKey(provider: string, value: string): Promise<ByokKey> {
  const k = await invokeStrict<ByokKey>("byok_set", { provider, value });
  await refreshByok();
  return k;
}

export async function removeKey(provider: string): Promise<void> {
  try {
    await invokeStrict<null>("byok_delete", { provider });
  } finally {
    // Even a partial delete (the app forgot it, the keychain kept its copy)
    // must leave the UI agreeing with the index, or a model stays in the
    // picker with no credential behind it.
    await refreshByok();
  }
}

/* ── spending one ───────────────────────────────────────────────────────── */

export interface ByokReply {
  ok: boolean;
  status: number;
  body: string;
  headers: Record<string, string>;
}

export class ByokError extends Error {
  // Assigned in the body rather than as constructor parameter properties:
  // `node --test` runs TypeScript in strip-only mode and refuses those, and
  // this module is on the import path of anything that tests an adapter.
  readonly provider: string;
  readonly status: number;
  readonly body?: string;
  constructor(provider: string, status: number, message: string, body?: string) {
    super(message);
    this.name = "ByokError";
    this.provider = provider;
    this.status = status;
    this.body = body;
  }
}

/**
 * One authenticated request to a provider.
 *
 * `path` is joined onto that provider's base, so a caller cannot choose the
 * host — and Rust checks it again anyway, because a check the caller performs
 * is a check the caller can skip.
 */
export async function byokFetch(
  provider: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<ByokReply> {
  const base = BYOK_BASE[provider];
  if (!base) throw new ByokError(provider, 0, `'${provider}' is not a provider this build can call`);
  const url = path.startsWith("https://") ? path : `${base}${path}`;
  const headers = { ...(BYOK_HEADERS[provider] ?? {}), ...(init.headers ?? {}) };
  return await invokeStrict<ByokReply>("byok_fetch", {
    provider, url,
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? null
      : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
}

/** byokFetch, but a non-2xx is an exception carrying the provider's own text.
 *
 *  Every adapter wants this shape; leaving each to check `ok` itself is how
 *  one of them ends up parsing an error body as a result. */
export async function byokJson<T = unknown>(
  provider: string, path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const r = await byokFetch(provider, path, init);
  if (!r.ok) throw new ByokError(provider, r.status, explainStatus(provider, r), r.body);
  try {
    return JSON.parse(r.body) as T;
  } catch {
    throw new ByokError(provider, r.status,
      `${label(provider)} answered ${r.status} with something that is not JSON`, r.body);
  }
}

const label = (p: string) => providerById(p)?.label ?? p;

/** The provider's own sentence where it has one, and a plain reason where it
 *  does not. A raw JSON envelope in a toast is the thing `explainError` on the
 *  director path already exists to stop. */
export function explainStatus(provider: string, r: Pick<ByokReply, "status" | "body">): string {
  const name = label(provider);
  let detail = "";
  try {
    const j = JSON.parse(r.body) as Record<string, unknown>;
    const e = (j.error ?? j) as Record<string, unknown>;
    detail = [e.message, e.detail, (j as { detail?: unknown }).detail]
      .find((x) => typeof x === "string") as string ?? "";
  } catch { /* not JSON — the status carries the meaning */ }
  const why =
    r.status === 401 || r.status === 403
      ? `${name} rejected the key — check it is current and has credit.`
      : r.status === 429 ? `${name} is rate limiting this key.`
      : r.status === 402 ? `${name} says this key has no credit.`
      : r.status >= 500 ? `${name} had a server error (${r.status}).`
      : `${name} refused the request (${r.status}).`;
  return detail ? `${why} ${detail}` : why;
}

/* ── verification ───────────────────────────────────────────────────────── */

export interface VerifyResult {
  ok: boolean;
  detail: string;
  /** the account label to record, when the provider names one */
  account?: string | null;
}

/**
 * Prove a stored key works, without spending anything.
 *
 * NEVER a generation. A verify that renders an image bills the user for
 * pressing a button labelled "check" — and would make the natural reflex
 * (press it again) cost money each time.
 */
export async function verifyKey(provider: string): Promise<VerifyResult> {
  const p: ByokProvider | undefined = providerById(provider);
  if (!p) return { ok: false, detail: `'${provider}' is not a provider this build can call` };
  let r: ByokReply;
  try {
    r = await byokFetch(provider, p.verify.path);
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e) };
  }
  // See ByokProvider.verify.okStatuses: fal has no free identity endpoint, so
  // "authenticated but that request id does not exist" IS the pass.
  const ok = r.ok || (p.verify.okStatuses?.includes(r.status) ?? false);
  if (!ok) return { ok: false, detail: explainStatus(provider, r) };

  let account: string | null = null;
  if (p.verify.account) {
    try { account = p.verify.account(JSON.parse(r.body)); } catch { /* optional */ }
  }
  // Best effort: a key that verified and whose label would not save is still
  // a key that verified.
  await invoke("byok_note_account", { provider, account });
  await refreshByok();
  return { ok: true, detail: account ? `Working · ${account}` : "Working", account };
}

/* ── THERE IS NOWHERE ELSE FOR A KEY TO GO ──────────────────────────────────
 *
 * The cloud build had a second, encrypted copy of a key in a server-side vault,
 * because its planner and its per-block renders ran on a machine the keychain
 * could not reach. Here the pipeline's Python runs on THIS computer — Rust
 * reads the key out of the keychain and places it into the child's environment
 * (see `src-tauri/src/planner.rs`) — so a key in the keychain already reaches
 * everything that could spend it, and there is no second store to keep in step.
 */

/* ── the model config ───────────────────────────────────────────────────── */

function saveConfig(next: ByokConfig) {
  writeConfig(next);
  publish({ config: next });
}

export function setHidden(id: string, hidden: boolean) {
  const set = new Set(state.config.hidden);
  if (hidden) set.add(id); else set.delete(id);
  saveConfig({ ...state.config, hidden: [...set] });
}

export function addCustomModel(m: CustomModel) {
  const custom = state.config.custom.filter((c) => c.id !== m.id).concat(m);
  // Adding a model that was previously hidden must SHOW it: the gesture is
  // "put this in my picker", and leaving it hidden makes the add look like a
  // no-op.
  saveConfig({ hidden: state.config.hidden.filter((h) => h !== m.id), custom });
}

export function removeCustomModel(id: string) {
  saveConfig({
    hidden: state.config.hidden.filter((h) => h !== id),
    custom: state.config.custom.filter((c) => c.id !== id),
  });
}

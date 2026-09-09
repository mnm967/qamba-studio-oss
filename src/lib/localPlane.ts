// The local storage plane: projects that live on this machine.
//
// WHAT IT IS. A project whose rows are a file under the app's data directory
// and whose media is a folder beside it, instead of rows in Supabase and
// objects in B2. Everything else about it is the same project — same tables,
// same shapes, same screens — which is why the storyboard, the timeline, the
// bible and the queue all work on one without knowing it is local.
//
// WHICH PLANE A QUERY GOES TO IS DECIDED BY THE URL, NOT BY A MODE FLAG.
// Every project-scoped route in this app is `/project/:pid/…`, so the open
// project is readable from `location.pathname` at the moment a query runs.
// A mode flag would have to be set before any descendant's effect fires and
// cleared on every exit; the ordering bug that hides in that ("the first
// query after opening a local project went to the cloud and came back empty,
// and nothing refetched") is exactly the kind of failure this plane cannot
// afford. The URL is already correct on the first render, after a reload, and
// after a back button.
//
// WHAT STAYS ON THE CLOUD PLANE, ALWAYS. `model_catalog`, `pod_status`,
// `job_timings`, `profiles`, the visibility tables and the shares. None of
// them is part of a project (`neon_owned_tables()` is the canonical list and
// `localSchema.ts` is derived from it), so a local project reads them from
// Supabase exactly as a cloud one does — and when there is no session, they
// come back empty, which is the honest answer: the model catalog is the
// studio's, not this machine's.
import { invalidateTables } from "../hooks/useLiveQuery";
import { isDesktop, invoke, invokeBytes, setLocalMediaOrigin } from "./desktop.ts";
import { saveDueAt } from "./localSaveCadence.ts";
import { localFrom } from "./localQuery.ts";
import { localRpc } from "./localRpc.ts";
import { LOCAL_TABLES, LOCAL_TABLE_SET } from "./localSchema.ts";
import { diag } from "./playbackDiag.ts";
import { LocalStore, uuid, type Row, type StoreSnapshot } from "./localStore.ts";
import { installPlane } from "./planeRouter.ts";
import { projectIdFromPath } from "./localScope.ts";
import type { JobIO } from "./jobIO.ts";

export interface StoredProject { id: string; json: string; media_bytes: number }


const OWNER_KEY = "qamba.local.owner";
const SYNCED_KEY = "qamba.local.synced";

/**
 * When THIS machine last finished a transfer for a project.
 *
 * In localStorage rather than on the project row, for two reasons: writing it
 * to the row would bump that row's own `updated_at` and make the project look
 * edited by the very act of recording that it was not, and the fact is about
 * this MACHINE (which copy it last matched) rather than about the project —
 * two desktops holding the same project have two different answers.
 */
export function syncedAt(projectId: string): string | null {
  try {
    const all = JSON.parse(localStorage.getItem(SYNCED_KEY) ?? "{}") as Record<string, string>;
    return all[projectId] ?? null;
  } catch { return null; }
}

export function markSynced(projectId: string, when = new Date().toISOString()): void {
  try {
    const all = JSON.parse(localStorage.getItem(SYNCED_KEY) ?? "{}") as Record<string, string>;
    all[projectId] = when;
    localStorage.setItem(SYNCED_KEY, JSON.stringify(all));
  } catch { /* a lost marker costs a vaguer sentence, nothing more */ }
}

interface Entry {
  store: LocalStore;
  mediaBytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** When `timer` will fire, so a change wanting the file SOONER can pull it
   *  forward instead of queueing behind it. */
  dueAt: number;
  /** When the last write STARTED, for the throttle. */
  lastSaveAt: number;
  /** A save already in flight — the next one waits for it rather than racing
   *  it, so two writes can never land out of order. */
  saving: Promise<void>;
  /** Media keys ACTUALLY ON DISK — null until the first scan lands.
   *
   *  The row index (`keys()`) answers "which project does this key belong
   *  to"; this answers "is the file really here", which is a different
   *  question the moment a pull is interrupted: the rows all arrive in the
   *  snapshot, the media loop stops partway, and every un-pulled key then
   *  resolved to an `asset://` path that 404s — measured on a real project,
   *  677 of 957 rows. A key that is registered but absent returns null from
   *  `localMediaUrl`, and `mediaUrl()` in supabase.js already falls through
   *  to the CDN — where a pulled project's copy still exists, because a pull
   *  deliberately leaves the cloud copy alone. */
  mediaKeys: Set<string> | null;
  /** debounce for the rescan an assets-table change schedules */
  scanTimer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, Entry>();
let root: string | null = null;
/** `http://127.0.0.1:<port>/<token>`, or null until `bootLocalPlane` has
 *  asked — and on a build whose Rust half predates the media server. */
let mediaOrigin: string | null = null;
let booted = false;
/** Set by the harness and the tests; `null` means "read the URL". */
let override: string | null | undefined;
let keyIndex: Map<string, string> | null = null;

/**
 * Who owns local rows.
 *
 * NOT the signed-in account, deliberately. A local project has to keep working
 * when nobody is signed in — that is most of the point — and it must not
 * change hands because a second person signed into this copy of the app. It is
 * one stable id per install, and `cloudSync` strips it on the way up so the
 * database's own trigger derives the real owner.
 */
export function localOwnerId(): string {
  let id = localStorage.getItem(OWNER_KEY);
  if (!id) {
    id = `local-${uuid()}`;
    localStorage.setItem(OWNER_KEY, id);
  }
  return id;
}

/* ── which project is open ──────────────────────────────────────────────── */

/** The local project the app is inside, or null — including "the open project
 *  is a cloud one", which is the common case. */
export function activeLocalProjectId(): string | null {
  const id = override !== undefined
    ? override
    : (typeof location !== "undefined" ? projectIdFromPath(location.pathname) : null);
  return id && entries.has(id) ? id : null;
}

/** Point the plane at a project by hand. The harness needs it (there is no
 *  router there) and so do the tests; nothing in the app calls it. Pass
 *  `undefined` to go back to reading the URL. */
export function setActiveLocalProject(id: string | null | undefined): void {
  override = id;
}

export const isLocalProject = (id: string | null | undefined): boolean =>
  !!id && entries.has(id);

export function localStoreFor(id: string): LocalStore | null {
  return entries.get(id)?.store ?? null;
}

export function activeLocalStore(): LocalStore | null {
  const id = activeLocalProjectId();
  return id ? entries.get(id)!.store : null;
}

/** Every local project's own `projects` row, newest first — the projects list
 *  merges these with the cloud's. */
export function localProjects(): Row[] {
  const out: Row[] = [];
  for (const [id, e] of entries) {
    const row = e.store.find("projects", id);
    if (row) out.push(JSON.parse(JSON.stringify(row)));
  }
  return out.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
}

export function localProjectBytes(id: string): number {
  return entries.get(id)?.mediaBytes ?? 0;
}

/**
 * Ask the disk what a project's media actually weighs.
 *
 * The cached figure is seeded at boot and incremented by `writeLocalMedia`,
 * which covers everything the BROWSER writes — and misses everything Rust
 * writes, which is every file a pull brings down. The symptom was a storage
 * modal reading "— on disk" beside 957 files it had just copied. Cheap (one
 * directory walk) and best effort: a failure leaves the previous number.
 */
export async function refreshLocalUsage(id: string): Promise<number> {
  const e = entries.get(id);
  if (!e) return 0;
  const usage = await invoke<{ bytes: number; files: number }>("local_media_usage", { projectId: id });
  if (usage) e.mediaBytes = usage.bytes;
  return e.mediaBytes;
}

/** Every local store, for the two callers that work across projects rather
 *  than inside one: the desktop worker's queues, and the sync. */
export function localStores(): LocalStore[] {
  return [...entries.values()].map((e) => e.store);
}

/**
 * The three things a background render needs, bound to ONE local project.
 *
 * See jobIO.ts for why this travels with the job instead of being read off the
 * open project: a local render that finished while a cloud project was on
 * screen would otherwise upload to the bucket and register the row there.
 */
export function localJobIO(store: LocalStore): JobIO {
  return {
    from: (table: string) => localFrom(store, table),
    upload: (file, key, onProgress) => writeLocalMedia(store.projectId, key, file, onProgress),
    register: async (a) => {
      const [row] = store.insert("assets", [{ origin: "uploaded", meta: {}, tags: [], ...a }],
        { onConflict: "b2_key" });
      return JSON.parse(JSON.stringify(row));
    },
  };
}

/* ── boot ───────────────────────────────────────────────────────────────── */

/**
 * Read every local project off disk and install the router.
 *
 * Called once from the shell. A no-op off the desktop, so the web build never
 * installs a plane and `planeFrom` keeps returning null there forever.
 */
export async function bootLocalPlane(): Promise<number> {
  if (booted || !isDesktop()) return entries.size;
  booted = true;
  root = await invoke<string>("local_store_root");
  // Where this machine will serve media from. Asked for ONCE and up front,
  // because `localMediaUrl` is synchronous and called from render paths — and
  // null is a legitimate answer (an older binary with no such command), which
  // falls back to `asset://` below rather than to a blank card.
  mediaOrigin = await invoke<string>("local_media_origin");
  setLocalMediaOrigin(mediaOrigin);
  const stored = (await invoke<StoredProject[]>("local_store_list")) ?? [];
  for (const p of stored) {
    try {
      adopt(LocalStore.fromSnapshot(JSON.parse(p.json) as StoreSnapshot, localOwnerId()), p.media_bytes);
    } catch (e) {
      // One unreadable project must not cost the user the others, and must not
      // be silently dropped either: it stays on disk, absent from the list,
      // with the reason on the console.
      console.error(`[local] could not open project ${p.id}`, e);
    }
  }
  installRouter();
  return entries.size;
}

/** Test seam. The plane is a module singleton, like the local worker's loop. */
export function __resetLocalPlane(): void {
  for (const e of entries.values()) if (e.timer) clearTimeout(e.timer);
  entries.clear();
  booted = false;
  override = undefined;
  root = null;
  mediaOrigin = null;
  setLocalMediaOrigin(null);
  keyIndex = null;
  installPlane(null);
}

/** Test/harness seam: adopt an in-memory store with no disk behind it. */
export function __adoptLocalStore(store: LocalStore, mediaBytes = 0): void {
  adopt(store, mediaBytes);
  installRouter();
}

function installRouter(): void {
  installPlane({
    from(table: string) {
      const store = activeLocalStore();
      if (!store) return null;
      if (!LOCAL_TABLE_SET.has(table)) return null;
      return localFrom(store, table);
    },
    mediaUrl(key: string) {
      return localMediaUrl(key);
    },
    ownerId() {
      return activeLocalStore() ? localOwnerId() : null;
    },
    rpc(name: string, args: Record<string, unknown> | undefined) {
      const store = activeLocalStore();
      return store ? localRpc(store, name, args ?? {}) : null;
    },
  });
}

function adopt(store: LocalStore, mediaBytes: number): void {
  const entry: Entry = {
    store, mediaBytes, timer: null, dueAt: 0, lastSaveAt: 0, saving: Promise.resolve(),
    mediaKeys: null, scanTimer: null,
  };
  entries.set(store.projectId, entry);
  void refreshMediaKeys(store.projectId);
  store.onChange((c) => {
    if (c.tables.includes("assets")) {
      keyIndex = null;
      // The rows changed, so the DISK may have too — the pipeline's Python
      // writes media straight into the folder (media.py, folder mode) and
      // registers the row through the loopback proxy, which is the one writer
      // `writeLocalMedia`'s own bookkeeping cannot see. Debounced: a plan
      // registers dozens of rows in a burst and one walk covers them all.
      scheduleMediaScan(store.projectId);
    }
    scheduleSave(store.projectId, c.tables);
    // The local plane has no realtime. Every live surface in this app
    // refetches on an invalidation, so this IS the replacement — without it a
    // local project renders once and then never moves.
    invalidateTables(c.tables);
  });
}

/* ── persistence ────────────────────────────────────────────────────────── */

/**
 * Queue a write of `projectId`, at the cadence its CHANGE deserves.
 *
 * `saveDueAt` decides how soon, from what changed; this decides what to do
 * about a write already queued, and the answer is that a SOONER one wins.
 * Without that a beat edit landing behind a render's progress tick would
 * inherit the tick's ten seconds, which is the one way the deferred cadence
 * could cost somebody an edit.
 */
function scheduleSave(projectId: string, tables: string[] = []): void {
  const e = entries.get(projectId);
  if (!e || !isDesktop()) return;
  const now = Date.now();
  const due = saveDueAt(tables, e.lastSaveAt, now);
  if (e.timer) {
    if (e.dueAt <= due) return;              // something at least as soon is queued
    clearTimeout(e.timer);
    e.timer = null;
  }
  if (due <= now) { void saveNow(projectId); return; }
  e.dueAt = due;
  e.timer = setTimeout(() => { e.timer = null; void saveNow(projectId); }, due - now);
}

/** Write a project's rows now. Serialised per project: a second save waits for
 *  the first, so two overlapping writes cannot land in the wrong order. */
export function saveNow(projectId: string): Promise<void> {
  const e = entries.get(projectId);
  if (!e || !isDesktop()) return Promise.resolve();
  e.lastSaveAt = Date.now();
  e.saving = e.saving.then(async () => {
    // ONE pass to serialize (see `snapshotJson`) and the bytes go over the
    // wire as bytes. As a named JSON argument the document was escaped into
    // another JSON document — every quote in 11MB of project doubling it to
    // ~22MB — sent, and then `serde_json`-parsed back on the app's MAIN
    // thread, which is also the thread serving `asset://` media to the
    // player. `application/octet-stream` is Tauri's raw-body path: the
    // command reads `InvokeBody::Raw` and writes it to disk unparsed.
    const t0 = performance.now();
    const body = new TextEncoder().encode(e.store.snapshotJson());
    const t1 = performance.now();
    try {
      await invokeBytes("local_store_save", body, { "qamba-project": projectId });
      if (import.meta.env.DEV) diag(`SAVE bytes=${body.length} stringify=${Math.round(t1 - t0)}ms ipc=${Math.round(performance.now() - t1)}ms`);
    } catch (err) {
      console.error(`[local] could not save ${projectId}`, err);
    }
  });
  return e.saving;
}

/**
 * A last chance to write, when the window is going away.
 *
 * Best effort by construction — the IPC message may not survive the unload —
 * which is exactly why the throttle above exists rather than a debounce: this
 * is the backstop for a write queued in the last 300ms, not the mechanism.
 * `pagehide` rather than `beforeunload`: the latter is unreliable in a webview
 * and is also the event browsers use to offer a confirmation dialog.
 */
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { void flushLocalPlane(); });
}

/** Flush every pending write. Called before a sync reads the file, and worth
 *  calling before anything that might end the process. */
export async function flushLocalPlane(): Promise<void> {
  await Promise.all([...entries.keys()].map((id) => {
    const e = entries.get(id)!;
    if (e.timer) { clearTimeout(e.timer); e.timer = null; }
    return saveNow(id);
  }));
}

/* ── creating and removing ──────────────────────────────────────────────── */

/**
 * A new project that lives on this machine.
 *
 * It mirrors `createProject` exactly — including the initial episode, because
 * every child table hangs off an episode and a project without one is a
 * project where half the app has nowhere to write.
 */
export async function createLocalProject(fields: Row): Promise<Row> {
  if (!isDesktop()) throw new Error("local projects are a desktop feature");
  if (!booted) await bootLocalPlane();
  const id = uuid();
  const store = new LocalStore(id, localOwnerId());
  const [project] = store.insert("projects", [{ ...fields, id }]);
  const isSeries = fields.medium === "series";
  store.insert("episodes", [{
    project_id: id,
    code: isSeries ? "EP01" : "MAIN",
    title: isSeries ? "Episode 1" : fields.title,
    idx: 0,
    status: "draft",
  }]);
  adopt(store, 0);
  installRouter();
  await saveNow(id);
  invalidateTables(["projects", "episodes"]);
  return JSON.parse(JSON.stringify(project));
}

/** Adopt a whole project (rows + an already-populated media directory). Used
 *  by the sync when it pulls a cloud project down. */
export async function adoptLocalSnapshot(snap: StoreSnapshot): Promise<void> {
  if (!isDesktop()) throw new Error("local projects are a desktop feature");
  if (!booted) await bootLocalPlane();
  const store = LocalStore.fromSnapshot(snap, localOwnerId());
  adopt(store, 0);
  installRouter();
  await saveNow(store.projectId);
  // EVERY TABLE, because this replaced every table.
  //
  // The local plane has NO REALTIME: a write announces itself through
  // `LocalStore.onChange` -> `invalidateTables(c.tables)`, and that is the only
  // thing that ever tells a `useLiveQuery` to refetch. This path does not go
  // through `onChange` at all — it swaps the whole store for a new one — so
  // announcing `projects` alone left every other surface rendering the rows it
  // had before: the storyboard, the bible, the library and, most visibly, the
  // timeline, which showed the pre-pull cut until the app was restarted. The
  // rows on disk were right the whole time, which is what made it read as "the
  // replace did not work".
  //
  // THE WHOLE LIST RATHER THAN `snap.tables`' KEYS: a table that HAD rows and
  // now has none changed too, and the snapshot omits an empty table entirely —
  // so keying off what arrived would leave exactly the surfaces whose contents
  // were deleted showing them. `invalidateTables` is a no-op for a table
  // nothing is watching, so the full list costs nothing.
  invalidateTables([...LOCAL_TABLES]);
}

/** Remove a local project and everything it owns — rows AND media, since
 *  nothing else on this machine points at either. */
export async function deleteLocalProject(id: string): Promise<void> {
  const e = entries.get(id);
  if (!e) return;
  if (e.timer) clearTimeout(e.timer);
  entries.delete(id);
  keyIndex = null;
  await invoke("local_store_delete", { projectId: id });
  invalidateTables(["projects"]);
}

/* ── media ──────────────────────────────────────────────────────────────── */

/** key -> which local project holds it. Rebuilt whenever any store's `assets`
 *  table changes, which is the only thing that can add a key. */
function keys(): Map<string, string> {
  if (keyIndex) return keyIndex;
  const idx = new Map<string, string>();
  for (const [id, e] of entries) {
    for (const row of e.store.rows("assets")) if (row.b2_key) idx.set(row.b2_key, id);
  }
  keyIndex = idx;
  return idx;
}

/** Which local project holds a key, or null when it belongs in the bucket.
 *  `deleteMedia` routes on this rather than on the open project — emptying the
 *  bin can name files from several places at once. */
export function localKeyOwner(key: string): string | null {
  return keys().get(key) ?? null;
}

/** Where a local media file sits. Public because the sync needs to name it. */
export function localMediaPath(projectId: string, key: string): string | null {
  return root ? `${root}/${projectId}/media/${key}` : null;
}

/**
 * A URL the page can actually load for a key held on this machine, or null
 * for a key that belongs in the bucket.
 *
 * `mediaUrl()` in lib/supabase.js asks this first, so every surface in the app
 * — the library grid, the player, the filmstrip, the reference picker —
 * resolves local media with no changes of its own.
 */
export function localMediaUrl(key: string): string | null {
  if (!key || /^https?:\/\//.test(key)) return null;
  const projectId = keys().get(key);
  if (!projectId) return null;
  // A ROW naming the key is not the FILE being here. Null sends the caller
  // back to `mediaUrl()`'s own CDN fallthrough — the honest answer for a
  // partially-pulled project, whose missing files still exist in the bucket.
  // An unscanned set (null) keeps the old behaviour: guessing CDN before the
  // first walk lands would flash remote URLs at boot for a project whose
  // files are all here.
  const present = entries.get(projectId)?.mediaKeys;
  if (present && !present.has(key)) return null;
  // OVER LOOPBACK RATHER THAN `asset://`, and the reason is the transport.
  // Tauri's asset protocol is answered by a scheme handler on the app's MAIN
  // THREAD and caps one Range response at 1000 * 1024 bytes, so a 10MB take —
  // ordinary here — was ten sequential main-thread round trips competing with
  // every IPC message for the same thread. That is what "buffering…" on a
  // fully local project was. Our own server has no cap, runs a task per
  // request off the main thread, and sends `Access-Control-Allow-Origin: *`.
  //
  // Each segment is encoded and the separators are not: a key is a path of
  // segments (`blocks/EP03/039/take_<uuid>.mp4`) and the server splits on the
  // slashes before it decodes.
  if (mediaOrigin) {
    const safe = key.split("/").map(encodeURIComponent).join("/");
    return `${mediaOrigin}/${encodeURIComponent(projectId)}/${safe}`;
  }
  // No server: a build whose Rust half predates it, or a bridge that has none.
  // `asset://` is what this always did — slower, and still correct.
  const path = localMediaPath(projectId, key);
  if (!path) return null;
  const convert = (window as any).__TAURI__?.core?.convertFileSrc;
  // The fallback is what Tauri's own `convertFileSrc` builds; it is here so a
  // bridge without it degrades to a URL rather than to a blank card.
  return convert ? convert(path) : `asset://localhost/${encodeURIComponent(path)}`;
}

/** ~4MB of bytes per IPC message. Base64 inflates by a third, so this is a
 *  ~5.3MB string — large enough that a still is one message and small enough
 *  that a long video does not stall the webview for a second at a time. */
const CHUNK = 4 * 1024 * 1024;

/**
 * Write a file into a local project's media directory.
 *
 * This is the local half of `uploadMedia` — same key, same registry row after
 * it, so nothing downstream can tell which plane the bytes went to. The
 * project is named rather than looked up: a background render publishes into
 * the project it belongs to, not the one on screen.
 */
export async function writeLocalMedia(
  projectId: string,
  key: string,
  file: Blob,
  onProgress?: (frac: number) => void,
): Promise<{ key: string }> {
  if (!entries.has(projectId)) throw new Error(`${projectId} is not a local project`);
  const buf = new Uint8Array(await file.arrayBuffer());
  let sent = 0;
  let append = false;
  do {
    const slice = buf.subarray(sent, sent + CHUNK);
    await invokeStrictLocal("local_media_write", {
      projectId, key, data: base64(slice), append,
    });
    sent += slice.length;
    append = true;
    onProgress?.(buf.length ? sent / buf.length : 1);
  } while (sent < buf.length);
  const e = entries.get(projectId);
  if (e) {
    e.mediaBytes += buf.length;
    // The file is on disk NOW, so the present-set says so NOW. Left to the
    // debounced rescan, every URL resolved in between falls through to the
    // CDN — which for a local project's own render is a 404 that the element
    // never retries (see PreviewPlayer's retry). This is the same exactness
    // `noteLocalMediaKey` gives the sync, at the one other place this module
    // knows a file has landed.
    e.mediaKeys?.add(key);
  }
  keyIndex = null;
  return { key };
}

export async function deleteLocalMedia(keys_: string[]): Promise<{ deleted: string[] }> {
  const byProject = new Map<string, string[]>();
  for (const key of keys_) {
    const pid = keys().get(key) ?? activeLocalProjectId();
    if (!pid) continue;
    if (!byProject.has(pid)) byProject.set(pid, []);
    byProject.get(pid)!.push(key);
  }
  for (const [projectId, list] of byProject) {
    await invoke("local_media_delete", { projectId, keys: list });
    const e = entries.get(projectId);
    for (const k of list) e?.mediaKeys?.delete(k);
  }
  keyIndex = null;
  return { deleted: keys_ };
}

/**
 * Re-read what is actually on disk for one project.
 *
 * One Rust walk (~ms for a thousand files), REPLACING the set atomically — a
 * clear-then-repopulate window would resolve everything to the CDN for a
 * frame. A failed walk leaves whatever was known rather than blanking it.
 */
export async function refreshMediaKeys(projectId: string): Promise<void> {
  const list = await invoke<string[]>("local_media_list", { projectId });
  const e = entries.get(projectId);
  if (!e || !list) return;
  const before = e.mediaKeys;
  e.mediaKeys = new Set(list);
  // A SCAN THAT CHANGED THE ANSWER HAS TO REACH THE SURFACES, or it is a fact
  // nothing acts on. Everything that shows media resolves its URL during a
  // RENDER (`mediaUrl` -> `localMediaUrl`, synchronously off this set), so a
  // set that changes with nothing re-rendering leaves every one of them
  // holding the URL the old set produced — for a key this scan just learned,
  // that is the CDN fallthrough, i.e. a 404 for a local project's own render.
  // Measured exactly that way: the pipeline's Python wrote a trim into the
  // media folder and registered the row, the player resolved the CDN in the
  // same tick, and the correct URL arrived 1.5s later with nobody listening.
  if (!before || before.size !== e.mediaKeys.size
      || [...e.mediaKeys].some((k) => !before.has(k))) {
    invalidateTables(["assets"]);
  }
}

function scheduleMediaScan(projectId: string): void {
  const e = entries.get(projectId);
  if (!e || !isDesktop()) return;
  if (e.scanTimer) return;
  e.scanTimer = setTimeout(() => {
    e.scanTimer = null;
    void refreshMediaKeys(projectId);
  }, 1500);
}

/** A file just landed on disk by some path this module did not drive — the
 *  sync's `local_media_download`, mainly. Cheaper than a rescan, and exact. */
export function noteLocalMediaKey(projectId: string, key: string): void {
  entries.get(projectId)?.mediaKeys?.add(key);
}

/** How many of a project's registered media files are actually here.
 *  Synchronous off the maintained set, so a storage sheet can ask on every
 *  render; null while the first scan has not landed. */
export function localMediaGaps(projectId: string): { missing: number; total: number } | null {
  const e = entries.get(projectId);
  if (!e?.mediaKeys) return null;
  const rows = (e.store.rows("assets") as { b2_key?: string }[]).filter((a) => a.b2_key);
  const missing = rows.filter((a) => !e.mediaKeys!.has(a.b2_key!)).length;
  return { missing, total: rows.length };
}

export async function localMediaExists(projectId: string, key: string): Promise<boolean> {
  return (await invoke<boolean>("local_media_exists", { projectId, key })) === true;
}

/** Base64 without a data URL round trip. `btoa` takes a binary string, and
 *  building one with `String.fromCharCode(...chunk)` blows the argument limit
 *  on anything over ~100KB — which is every video this writes. */
function base64(bytes: Uint8Array): string {
  let s = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    s += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(s);
}

/** `invoke` swallows errors and returns null, which is right for a probe and
 *  wrong for a write: a media file that failed to land must not look like one
 *  that did, or the registry row points at nothing. */
async function invokeStrictLocal<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const t = (window as any).__TAURI__;
  if (!t) throw new Error(`${cmd} is only available in the desktop app`);
  return await t.core.invoke(cmd, args);
}

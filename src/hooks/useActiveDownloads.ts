// Weight downloads in flight, for any surface that wants to show them.
//
// WHY A HOOK AND NOT MODAL STATE. A download outlives the engine modal — the
// Rust task keeps writing after the screen unmounts — so "what is downloading"
// is a property of the APP, not of one component. Keeping it in the modal is
// what made a reopened modal offer to download a file already gigabytes in.
//
// It POLLS as well as listening. The `download://progress` event carries the
// live bytes and is the fast path, but it only fires while something is
// actively transferring: a surface that mounts mid-download would otherwise
// sit blank until the next megabyte, and one that mounts after the last event
// would never learn the download had ENDED. The poll is what makes both
// self-correcting, and it is cheap — a lock and a map clone in Rust.
import { useCallback, useEffect, useRef, useState } from "react";
import { activeDownloads, isDesktop, listen, type ActiveDownload } from "../lib/desktop";

/** Interval is deliberately unhurried: progress events do the smooth updating,
 *  and this only has to catch the start and the end. */
const POLL_MS = 1500;

export interface DownloadRow extends ActiveDownload {
  /** bare filename — the id already is one, but callers should not rely on that */
  name: string;
  /** 0..1, or -1 when the server sent no content-length */
  pct: number;
}

const toRow = (d: ActiveDownload): DownloadRow => ({
  ...d,
  name: d.id.split(/[\\/]/).pop() ?? d.id,
  pct: d.total > 0 ? d.received / d.total : -1,
});

export function useActiveDownloads(enabled = true): DownloadRow[] {
  const [rows, setRows] = useState<DownloadRow[]>([]);
  const alive = useRef(true);

  const sync = useCallback(async () => {
    const list = await activeDownloads().catch(() => []);
    if (alive.current) setRows(list.map(toRow));
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled || !isDesktop()) { setRows([]); return () => { alive.current = false; }; }

    void sync();
    const h = setInterval(() => void sync(), POLL_MS);
    let off: (() => void) | undefined;
    void listen<{ id: string; received: number; total: number; done: boolean }>(
      "download://progress",
      (p) => {
        if (!alive.current) return;
        // Update in place so the bar moves between polls; a `done` event
        // re-asks rather than guessing, because one file finishing does not
        // mean the model's other files are not about to start.
        if (p.done) { void sync(); return; }
        setRows((prev) => prev.some((r) => r.id === p.id)
          ? prev.map((r) => r.id === p.id
              ? { ...r, received: p.received, total: p.total,
                  pct: p.total > 0 ? p.received / p.total : -1 }
              : r)
          // A file we have not seen yet: the poll will fill in its dest, but
          // showing it now beats a blank row for up to POLL_MS.
          : [...prev, toRow({ id: p.id, received: p.received, total: p.total, dest: "" })]);
      },
    ).then((f) => { if (f) { if (alive.current) off = f; else f(); } });

    return () => { alive.current = false; clearInterval(h); off?.(); };
  }, [enabled, sync]);

  return rows;
}

/* ── stopped, half-finished downloads ───────────────────────────────────── */

export interface PausedDownload {
  filename: string;
  label: string;
  owner: string;
  url: string;
  dir: string;
  mb: number;
  totalMb: number;
}

/**
 * Downloads that STOPPED with bytes on disk, and the means to continue them.
 *
 * Separate from `useActiveDownloads` because they are the opposite state and
 * need different information: an in-flight download needs progress, a stopped
 * one needs a button. Nothing resumes on its own after an app restart, so
 * without this a `.part` is a few gigabytes that exist and cannot be reached.
 *
 * Anything in flight is excluded — the same file must not appear as both
 * "downloading" and "paused" while the registry and the disk briefly disagree.
 */
export function usePausedDownloads(active: DownloadRow[] = []): {
  paused: PausedDownload[]; resume: (p: PausedDownload) => Promise<void>; reload: () => void;
} {
  const [paused, setPaused] = useState<PausedDownload[]>([]);
  const [nonce, setNonce] = useState(0);
  const liveIds = active.map((a) => a.id).join(",");

  useEffect(() => {
    let alive = true;
    if (!isDesktop()) { setPaused([]); return () => { alive = false; }; }
    void (async () => {
      const [{ engineStatus }, cat] = await Promise.all([
        import("../lib/desktop"), import("../lib/engineCatalog"),
      ]);
      const s = await engineStatus().catch(() => null);
      if (!alive || !s) return;
      const partial = s.partial_mb ?? {};
      const owners = s.partial_owner ?? {};
      const have = new Set(s.files ?? []);
      const live = new Set(active.map((a) => a.id));
      const out: PausedDownload[] = [];
      for (const [filename, e] of cat.fileIndex()) {
        if (have.has(filename) || live.has(filename)) continue;
        const mb = cat.partialFor(filename, partial);
        if (mb > 0) {
          // The recorded owner beats the catalogue's, which for a shared file
          // is only ever "some family that uses it" — resuming should light up
          // the row that started it, not an arbitrary sibling.
          const stem = filename.replace(/\.[^.]+$/, "");
          const owner = owners[filename] ?? owners[stem] ?? e.owner;
          out.push({ filename, label: e.label, owner, url: e.file.url,
                     dir: e.file.dir, mb, totalMb: e.file.size_mb });
        }
      }
      setPaused(out);
    })();
    return () => { alive = false; };
  }, [nonce, liveIds]);   // eslint-disable-line react-hooks/exhaustive-deps

  const resume = useCallback(async (p: PausedDownload) => {
    const { invoke } = await import("../lib/desktop");
    const dest = await invoke<string>("engine_model_path",
      { kind: p.dir, filename: p.filename });
    if (!dest) return;
    await invoke<string>("download_model_file",
      { id: p.filename, url: p.url, dest, owner: p.owner });
    setNonce((n) => n + 1);
  }, []);

  return { paused, resume, reload: () => setNonce((n) => n + 1) };
}

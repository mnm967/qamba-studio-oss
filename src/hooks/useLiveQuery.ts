// Fetch-and-subscribe: run an async loader, refetch (debounced) whenever one
// of the named tables changes.
//
// WHAT "CHANGES" MEANS HERE. Every write to a local project goes through
// `LocalStore`, whose change event calls `invalidateTables` — so a beat edit,
// a landing render and a queued job all reach every surface watching their
// table, with no socket in between. The visibility handler below is the
// escape hatch for the one thing an in-process event cannot cover: a laptop
// that slept mid-render and wants a fresh look at everything on waking.
import { useCallback, useEffect, useRef, useState } from "react";
import { diag } from "../lib/playbackDiag";

const subs = new Map<string, Set<() => void>>();   // table -> invalidators
/** Debounced invalidator -> the hook's raw `run`. `invalidateTables` is for
 *  writes the app made itself, and its whole point is "now" — but the cb
 *  registered in `subs` is the debounced one, so going through it would
 *  quietly add 400ms. This map lets invalidation reach the undebounced fetch
 *  while a burst of writes keeps its debounce. */
const immediateOf = new Map<() => void, () => void>();
const hits = new Map<string, number>();   // dev diagnostics: events actually received

/** Call `cb` whenever any of `tables` changes. Returns an unsubscribe. */
export function subscribeTables(tables: string[], cb: () => void): () => void {
  for (const t of tables) {
    if (!subs.has(t)) subs.set(t, new Set());
    subs.get(t)!.add(cb);
  }
  return () => {
    for (const t of tables) subs.get(t)?.delete(cb);
  };
}

/** Re-run every live query bound to one of `tables`, now.
 *
 *  The local plane calls this on every write, which makes it the whole of
 *  "live" in this build: without it a project renders once and never moves. */
export function invalidateTables(tables: string[]) {
  const seen = new Set<() => void>();
  for (const t of tables) {
    hits.set(t, (hits.get(t) ?? 0) + 1);
    for (const cb of [...(subs.get(t) ?? [])]) {
      if (seen.has(cb)) continue;
      seen.add(cb);
      // Prefer the hook's undebounced fetch; fall back to the subscriber's own
      // callback for direct subscribeTables users (which debounce themselves).
      (immediateOf.get(cb) ?? cb)();
    }
  }
  if (import.meta.env.DEV) diag(`INVAL ${tables.join(",")} cbs=${seen.size}`);
}

/** Re-run every live query on screen. For the cases an in-process event
 *  structurally cannot cover: the machine was asleep, and whatever a background
 *  job wrote in the meantime landed while nothing was listening. */
function refetchAll() {
  const seen = new Set<() => void>();
  for (const set of subs.values()) for (const cb of set) if (!seen.has(cb)) { seen.add(cb); cb(); }
}

if (typeof window !== "undefined") {
  const heal = () => {
    if (document.visibilityState !== "visible") return;
    refetchAll();
  };
  document.addEventListener("visibilitychange", heal);
  window.addEventListener("online", heal);
}

// Dev-only handle, same rationale as __ws/__tl: lets a test fire an
// invalidation and count listeners. Stripped from prod builds.
if (import.meta.env.DEV) {
  (window as unknown as { __live?: unknown }).__live = {
    hits: () => Object.fromEntries(hits),
    listeners: () => Object.fromEntries([...subs].map(([t, s]) => [t, s.size])),
    fire: (t: string) => { for (const cb of [...(subs.get(t) ?? [])]) cb(); },
  };
}

/**
 * @param pollMs re-run on a timer as well as on invalidation. Zero (the
 * default) means invalidation only. Callers pass a poll interval *only while
 * work is in flight* (see LibraryView), so an idle screen still costs nothing.
 */
export function useLiveQuery<T>(
  loader: () => Promise<T>,
  tables: string[],
  deps: unknown[] = [],
  debounceMs = 400,
  pollMs = 0
): { data: T | null; error: Error | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // "No load has settled for the CURRENT deps yet." Background refetches do not
  // flip it back — only a deps change does — so surfaces can show a spinner on
  // first open without flashing one on every tick.
  const [loading, setLoading] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  // Request sequencing. Refetches overlap constantly here (invalidations +
  // polls + reload-after-write), and without this the last response to
  // RESOLVE won — not the last to start. That is exactly the "my edit showed,
  // reverted for a moment, then came back" flicker. A stale generation is
  // discarded.
  const gen = useRef(0);

  const run = useCallback(() => {
    const g = ++gen.current;
    loader()
      .then((d) => {
        if (!alive.current || g !== gen.current) return;
        setData(d);
        setError(null);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive.current || g !== gen.current) return;
        setError(e as Error);
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    run();
    const cb = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(run, debounceMs);
    };
    const off = subscribeTables(tables, cb);
    immediateOf.set(cb, run);
    return () => {
      alive.current = false;
      immediateOf.delete(cb);
      if (timer.current) clearTimeout(timer.current);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  useEffect(() => {
    if (!pollMs) return;
    const id = setInterval(() => { if (alive.current) run(); }, pollMs);
    return () => clearInterval(id);
  }, [pollMs, run]);

  return { data, error, loading, reload: run };
}

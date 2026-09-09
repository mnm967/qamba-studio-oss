// The parts of a Speech-tab engine card that are the SAME for every engine.
//
// Extracted when Qwen3-TTS became the second one. What is shared is the shell
// and the two behaviours that were bugs in `OllamaSection` first — adopting an
// install that is already running (it outlives the modal, and a card offering
// Install again would open a second writer on one directory) and polling while
// anything is in flight (an ADOPTED install has no `run()` of its own to clear
// `busy`, which is what would otherwise spin forever).
//
// What is NOT shared is the copy: the licence, the memory, and what each
// engine cannot do. Those are the reasons to pick one, so each card states its
// own rather than inheriting a sentence written for the other.
import React, { useCallback, useEffect, useRef, useState } from "react";

export const INK = "#c7cddb";
export const MUTE = "#5e6678";
export const OK = "#6fd08c";
export const WARN = "#e8a13a";
export const ACCENT = "#5aa2ff";

export function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className="mono" style={{
      fontSize: 10, padding: "2px 7px", borderRadius: 999, whiteSpace: "nowrap",
      color: tone, background: `${tone}1a`, border: `1px solid ${tone}3d`,
    }}>{children}</span>
  );
}

export function Bar({ pct }: { pct: number }) {
  const indeterminate = pct < 0;
  return (
    <div className="ns-dlbar" style={{
      height: 4, borderRadius: 3, background: "rgba(255,255,255,0.07)",
      overflow: "hidden",
    }}>
      <i style={{
        display: "block", height: "100%", borderRadius: 3, background: ACCENT,
        width: indeterminate ? "35%" : `${Math.round(pct * 100)}%`,
        animation: indeterminate ? "ns-indet 1.2s ease-in-out infinite" : undefined,
      }} />
    </div>
  );
}

export interface EngineProgress { key: string; label: string; pct: number; detail: string }

/**
 * The live half of a Speech-tab card: current status, in-flight progress, and
 * a `run` that refreshes afterwards.
 *
 * `starting` is passed in rather than read off the status, because each engine
 * spells its own status type — what this needs to know is only whether to keep
 * polling.
 */
export function useEngineCard<S>(io: {
  status: () => Promise<S | null>;
  active: () => Promise<EngineProgress[] | null>;
  /** `listen` resolves to null off the desktop, so the unsubscribe is
   *  nullable as well as optional — both spellings, or a card that is
   *  correct at runtime fails to typecheck. */
  onProgress: (cb: (p: EngineProgress) => void)
    => Promise<(() => void) | null | undefined>;
  isStarting: (s: S | null) => boolean;
}) {
  const { status: getStatus, active: getActive, onProgress, isStarting } = io;
  const [status, setStatus] = useState<S | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [prog, setProg] = useState<EngineProgress | null>(null);
  const unlisten = useRef<(() => void)[]>([]);

  const refresh = useCallback(async () => { setStatus(await getStatus()); }, [getStatus]);

  /** Adopt an install already running — see the module note. */
  const syncActive = useCallback(async () => {
    const a = (await getActive()) ?? [];
    if (!a.length) return;
    setProg(a[0]);
    setBusy(true);
  }, [getActive]);

  useEffect(() => {
    void refresh();
    void syncActive();
    (async () => {
      const off = await onProgress((p) => setProg(p));
      unlisten.current = [off].filter(Boolean) as (() => void)[];
    })();
    return () => { unlisten.current.forEach((f) => f()); };
  }, [refresh, syncActive, onProgress]);

  const starting = isStarting(status);
  useEffect(() => {
    if (!busy && !starting) return;
    const h = setInterval(() => {
      void refresh();
      void getActive().then((a) => { if (a && !a.length) setBusy(false); });
    }, 3000);
    return () => clearInterval(h);
  }, [busy, starting, refresh, getActive]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProg(null);
    }
  };

  return { status, busy, err, prog, refresh, run };
}

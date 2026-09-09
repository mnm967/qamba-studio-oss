// The uncensored director's engine, on this machine — the LLM half of the
// local-engine screen.
//
// It is a SEPARATE section from the model families above it, and separate for
// a structural reason rather than a visual one: those rows download files into
// ComfyUI's model directories, and nothing there can install an Ollama model.
// Two engines, two stores. Sharing the section would mean one "Get" button
// meaning two different things.
//
// EVERY ROW HERE HAS A CONSUMER ON THIS MACHINE. That is the rule the section
// is built around: an uncensored model installed here is what `enhancePrompt`
// rewrites through when the pod is asleep. The reviewer's VLM judge is NOT
// offered, because its pipeline (ffmpeg sampling, ASR, the shot contract) runs
// on the pod and a judge row would be 17GB with nothing to load it.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Brain, Check, Download, ExternalLink, Loader2, Play, RefreshCw, Square,
  Trash2, TriangleAlert,
} from "lucide-react";
import {
  LOCAL_LLMS, blockedReason, daemonAction, daemonBlocked, fitBlocked, fmtGb,
  hasModel, installOllama, llmBudgetGb, ollamaActive, ollamaPull, ollamaRemove,
  ollamaStatus, onOllamaProgress, startOllama, stopOllama, updateOllama,
  versionNote,
  type LocalLlm, type OllamaProgress, type OllamaStatus,
} from "../../lib/ollamaLocal";
import { openExternal } from "../../lib/desktop";

const INK = "#c7cddb";
const MUTE = "#5e6678";
const OK = "#6fd08c";
const WARN = "#e8a13a";
const ACCENT = "#5aa2ff";

function Bar({ pct }: { pct: number }) {
  const indeterminate = pct < 0;
  return (
    <div className="ns-dlbar" style={{
      height: 4, borderRadius: 3, background: "rgba(255,255,255,0.07)",
      overflow: "hidden", position: "relative",
    }}>
      <div style={{
        height: "100%", borderRadius: 3, background: ACCENT,
        width: indeterminate ? "35%" : `${Math.round(Math.min(1, Math.max(0, pct)) * 100)}%`,
        transition: indeterminate ? undefined : "width .25s ease",
        animation: indeterminate ? "ns-slide 1.4s ease-in-out infinite" : undefined,
        opacity: indeterminate ? 0.75 : 1,
      }} />
    </div>
  );
}

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className="mono" style={{
      fontSize: 10, padding: "2px 7px", borderRadius: 999, whiteSpace: "nowrap",
      color: tone, background: `${tone}1a`, border: `1px solid ${tone}3d`,
    }}>{children}</span>
  );
}

export default function OllamaSection() {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [budgetGb, setBudgetGb] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** pull progress, keyed by model name — the Rust event carries which one */
  const [prog, setProg] = useState<Record<string, OllamaProgress>>({});
  const unlisten = useRef<(() => void)[]>([]);

  const refresh = useCallback(async () => {
    setStatus(await ollamaStatus());
  }, []);

  /**
   * Adopt whatever is already running.
   *
   * FOUND BY USING THE APP: press Update, close the modal, reopen — and the
   * card offered "Install a newer Ollama" again while the first download was
   * still writing. Local `busy`/`prog` die with the component; the Rust task
   * does not. Same lesson, same fix, as `syncActive` for weight files one
   * screen up. `""` is the daemon install, a model tag is a pull.
   */
  const syncActive = useCallback(async () => {
    const active = (await ollamaActive()) ?? [];
    if (!active.length) return;
    setProg((d) => {
      const next = { ...d };
      for (const p of active) next[p.model] = p;
      return next;
    });
    // Whichever is in flight owns the button; the daemon install wins when
    // both somehow are, because it is the one gating every row.
    const daemon = active.find((p) => !p.model);
    setBusy(daemon ? "daemon" : active[0].model);
  }, []);

  useEffect(() => {
    void refresh();
    void syncActive();
    void llmBudgetGb().then(setBudgetGb);
    (async () => {
      const off = await onOllamaProgress((p) => {
        // A pull carries its model; install/start progress does not, and
        // filing that under "" keeps it out of every row's bar.
        setProg((d) => ({ ...d, [p.model]: p }));
        if (p.label === "ready" && p.model) void refresh();
      });
      unlisten.current = [off].filter(Boolean) as (() => void)[];
    })();
    return () => { unlisten.current.forEach((f) => f()); };
  }, [refresh, syncActive]);

  // While a pull is running the daemon is the only thing that knows how far it
  // got; poll so a row that finishes while the modal is open flips to
  // "installed" without needing a reopen.
  useEffect(() => {
    if (!busy) return;
    const h = setInterval(() => {
      void refresh();
      // An ADOPTED operation has no `run()` of its own to clear `busy` when it
      // ends — without this the button would spin forever after a download
      // that finished while the modal was closed.
      void ollamaActive().then((a) => { if (a && !a.length) setBusy(null); });
    }, 3000);
    return () => clearInterval(h);
  }, [busy, refresh]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setProg((d) => ({ ...d, [key]: undefined as unknown as OllamaProgress }));
    }
  };

  const installed = !!status && (status.bundled || status.reachable);
  const running = !!status?.reachable;
  const act = daemonAction(status);
  const ACTIONS: Record<string, { fn: () => Promise<unknown>; icon: React.ReactNode }> = {
    install: { fn: installOllama, icon: <Download size={12} /> },
    update: { fn: updateOllama, icon: <RefreshCw size={12} /> },
    start: { fn: startOllama, icon: <Play size={12} /> },
    stop: { fn: stopOllama, icon: <Square size={12} /> },
  };
  const busyLabel: Record<string, string> = {
    install: "Installing…", update: "Updating…", start: "Starting…", stop: "Stopping…",
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "2px 2px 8px" }}>
        <Brain size={12} style={{ color: MUTE }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Uncensored director</span>
        <span style={{ fontSize: 11.5, color: MUTE }}>
          a language model on this machine — prompt rewrites that never leave it
        </span>
      </div>

      {/* ── the daemon ────────────────────────────────────────────────── */}
      <div className="ws-card" style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: INK }}>Ollama</span>
          {running && status?.foreign && <Pill tone={ACCENT}>already running · started outside the app</Pill>}
          {running && status?.ours && <Pill tone={OK}>running</Pill>}
          {!running && installed && <Pill tone={MUTE}>installed, not running</Pill>}
          {!installed && <Pill tone={MUTE}>not installed</Pill>}
          {status?.version && (
            <span className="mono" style={{ fontSize: 10.5, color: status.version_ok ? MUTE : WARN }}>
              v{status.version}
            </span>
          )}
          <div style={{ flex: 1 }} />
          {/* One decision, made in `daemonAction`. Note there is no Stop for a
              daemon the user started — killing that would take their own
              Ollama down with it. */}
          {act.kind !== "none" && (
            <button className="ws-btn" disabled={busy === "daemon"}
                    title={act.note ?? undefined}
                    onClick={() => void run("daemon", ACTIONS[act.kind].fn)}>
              {busy === "daemon"
                ? <><Loader2 size={12} className="ns-spin" /> {busyLabel[act.kind]}</>
                : <>{ACTIONS[act.kind].icon} {act.label}</>}
            </button>
          )}
        </div>

        {busy === "daemon" && prog[""] && (
          <div style={{ marginTop: 8 }}>
            <Bar pct={prog[""].pct} />
            <div className="mono" style={{ fontSize: 10, color: MUTE, marginTop: 4 }}>
              {prog[""].label} {prog[""].detail}
            </div>
          </div>
        )}

        {daemonBlocked(status) && (
          <div style={{
            display: "flex", gap: 7, alignItems: "flex-start", marginTop: 8,
            fontSize: 11, color: running && !status?.version_ok ? WARN : MUTE, lineHeight: 1.5,
          }}>
            <TriangleAlert size={12} style={{ flex: "none", marginTop: 2 }} />
            <span>{running && !status?.version_ok ? versionNote(status) : daemonBlocked(status)}</span>
          </div>
        )}

        {/* What the button will actually do, when that needs saying — the
            foreign-daemon case is the one where pressing it is not the whole
            fix. */}
        {act.note && (
          <div style={{ fontSize: 10.5, color: MUTE, marginTop: 6, lineHeight: 1.5 }}>
            {act.note}{" "}
            <button className="ws-link" style={{ color: ACCENT }}
                    onClick={() => void openExternal("https://ollama.com/download")}>
              update yours instead <ExternalLink size={9} />
            </button>
          </div>
        )}
      </div>

      {/* ── the models ────────────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {LOCAL_LLMS.map((m: LocalLlm) => {
          const have = hasModel(status, m.name);
          const blocked = blockedReason(status, m, budgetGb);
          const p = prog[m.name];
          const pulling = busy === m.name;
          return (
            <div key={m.name} className="ws-card" style={{ padding: "9px 11px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12.5, color: INK, fontWeight: 600 }}>{m.label}</span>
                <Pill tone={MUTE}>{fmtGb(m.size_mb)}</Pill>
                <Pill tone={budgetGb > 0 && m.vram_gb > budgetGb ? WARN : MUTE}>
                  ~{m.vram_gb}GB to run
                </Pill>
                {m.recommended && <Pill tone={ACCENT}>recommended</Pill>}
                {have && <Pill tone={OK}><Check size={9} /> installed</Pill>}
                <div style={{ flex: 1 }} />
                {have ? (
                  <button className="ws-btn" title="Remove this model" disabled={pulling}
                          onClick={() => void run(m.name, () => ollamaRemove(m.name))}>
                    <Trash2 size={12} />
                  </button>
                ) : (
                  <button className="ws-btn" disabled={!!blocked || pulling}
                          title={blocked ?? `Download ${m.name}`}
                          onClick={() => void run(m.name, () => ollamaPull(m.name))}>
                    {pulling
                      ? <><Loader2 size={12} className="ns-spin" /> Downloading…</>
                      : <><Download size={12} /> Get</>}
                  </button>
                )}
              </div>

              <p style={{ fontSize: 11, color: MUTE, margin: "6px 0 0", lineHeight: 1.55 }}>
                {m.blurb}
              </p>

              {pulling && p && (
                <div style={{ marginTop: 7 }}>
                  <Bar pct={p.pct} />
                  <div className="mono" style={{ fontSize: 10, color: MUTE, marginTop: 4 }}>
                    {p.label} {p.detail}
                  </div>
                </div>
              )}

              {/* Only the row-SPECIFIC reason renders here — the daemon's own
                  problems are stated once, on the card above. */}
              {fitBlocked(m, budgetGb) && !have && (
                <div style={{ fontSize: 10.5, color: WARN, marginTop: 6, lineHeight: 1.5 }}>
                  {fitBlocked(m, budgetGb)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {err && (
        <div style={{
          display: "flex", gap: 7, alignItems: "flex-start", marginTop: 8,
          fontSize: 11, color: WARN, lineHeight: 1.5,
        }}>
          <TriangleAlert size={12} style={{ flex: "none", marginTop: 2 }} />
          <span>{err}</span>
        </div>
      )}

      <p style={{ fontSize: 10.5, color: MUTE, margin: "7px 2px 0", lineHeight: 1.5 }}>
        Models live in Ollama&rsquo;s own store, so one pulled here is shared with any
        Ollama you already have. With one installed, the composer&rsquo;s <b>enhance</b>{" "}
        button rewrites prompts on this machine instead of waiting on the cloud.
      </p>
    </div>
  );
}

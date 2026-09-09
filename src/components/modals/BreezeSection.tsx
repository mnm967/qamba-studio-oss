// The Speech tab — Breeze TTS 2 on this machine.
//
// Modelled on `OllamaSection`, including the two things that were bugs there
// first: it ADOPTS work already running on mount (an install outlives the
// modal, and a card that offers Install again would open a second writer), and
// it dispatches a PURE action table rather than deciding in JSX.
//
// What it owes the reader beyond a button: the licence, because these weights
// are non-commercial and that is part of the decision to download 7.7GB; the
// memory, because ~8.5GB resident is most of a 16GB Mac; and the DEVICE, since
// the difference between MPS and CPU here is a line in seconds or a line in
// minutes.
import React, { useEffect, useState } from "react";
import { Download, Loader2, Mic, Play, Square, TriangleAlert } from "lucide-react";
import {
  breezeAction, breezeActive, breezeStatus, installBreeze, onBreezeProgress,
  remainingGb, startBreeze, stopBreeze, WEIGHT_FILES,
  type BreezeStatus,
} from "../../lib/breezeLocal";
import { detectHardware, machineBudgetGb } from "../../lib/desktop";
import {
  ACCENT, Bar, INK, MUTE, OK, Pill, useEngineCard, WARN,
} from "./voiceEngineCard";

/** ~8.5GB resident, measured beside a render on the pod. */
const RESIDENT_GB = 8.5;

export default function BreezeSection() {
  const [budgetGb, setBudgetGb] = useState(0);
  const { status, busy, err, prog, run } = useEngineCard<BreezeStatus>({
    status: breezeStatus,
    active: breezeActive,
    onProgress: onBreezeProgress,
    isStarting: (s) => Boolean(s?.starting),
  });

  useEffect(() => {
    void detectHardware().then((h) => setBudgetGb(machineBudgetGb(h)));
  }, []);

  const act = breezeAction(status);
  const tight = budgetGb > 0 && budgetGb < RESIDENT_GB;
  const ACTIONS: Record<string, { fn: () => Promise<unknown>; icon: React.ReactNode }> = {
    install: { fn: () => installBreeze(), icon: <Download size={12} /> },
    resume: { fn: () => installBreeze(), icon: <Download size={12} /> },
    start: { fn: startBreeze, icon: <Play size={12} /> },
    stop: { fn: stopBreeze, icon: <Square size={12} /> },
  };
  const left = status ? remainingGb(status) : 0;

  return (
    <div data-testid="breeze">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "2px 2px 8px" }}>
        <Mic size={12} style={{ color: MUTE }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Dialogue engine</span>
        <span style={{ fontSize: 11.5, color: MUTE }}>
          a voice on this machine — designed, cloned, offline
        </span>
      </div>

      <div className="ws-card" style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: INK }}>Breeze TTS 2</span>
          {status?.foreign && <Pill tone={WARN}>already running · started outside the app</Pill>}
          {status?.ours && <Pill tone={OK}>running</Pill>}
          {status?.starting && <Pill tone={ACCENT}>loading the model</Pill>}
          {!status?.reachable && !status?.starting && status?.installed
            && <Pill tone={MUTE}>installed, not running</Pill>}
          {!status?.installed && !status?.reachable && <Pill tone={MUTE}>not installed</Pill>}
          {status?.device && (
            <span className="mono" style={{ fontSize: 10.5, color: MUTE }}>
              {status.device}
            </span>
          )}
          <div style={{ flex: 1 }} />
          {/* One decision, made in `breezeAction`. There is no Stop for a
              server the user started themselves, and no Install while one is
              loading — see the ordering note there. */}
          {ACTIONS[act.kind] && (
            <button className="ws-btn" disabled={busy} title={act.note ?? undefined}
                    onClick={() => void run(ACTIONS[act.kind].fn)}>
              {busy
                ? <><Loader2 size={12} className="ns-spin" /> Working…</>
                : <>{ACTIONS[act.kind].icon} {act.label}
                    {left > 0.1 && ` · ${left.toFixed(1)}GB`}</>}
            </button>
          )}
          {act.kind === "wait" && (
            <span className="mono" style={{ fontSize: 10.5, color: MUTE }}>
              <Loader2 size={11} className="ns-spin" /> {act.label}
            </span>
          )}
        </div>

        {busy && prog && (
          <div style={{ marginTop: 8 }}>
            <Bar pct={prog.pct} />
            <div className="mono" style={{ fontSize: 10, color: MUTE, marginTop: 4 }}>
              {prog.label} {prog.detail}
            </div>
          </div>
        )}

        {act.note && (
          <div style={{
            display: "flex", gap: 7, alignItems: "flex-start", marginTop: 8,
            fontSize: 11, color: status?.foreign ? WARN : MUTE, lineHeight: 1.5,
          }}>
            <TriangleAlert size={12} style={{ flex: "none", marginTop: 2 }} />
            <span>{act.note}</span>
          </div>
        )}

        {err && (
          <div className="mono" style={{ fontSize: 10.5, color: "#ff6b6b", marginTop: 8 }}>
            {err}
          </div>
        )}
      </div>

      <div className="ws-card">
        <div style={{ fontSize: 11.5, color: INK, lineHeight: 1.55 }}>
          Designs a voice from a character&rsquo;s description and then speaks every
          line in it, so an episode can be voiced with no account and no key. A
          sigh, a laugh or a cough written into a line is performed rather than
          described.
        </div>
        <ul style={{
          margin: "8px 0 0", padding: "0 0 0 16px", fontSize: 11,
          color: MUTE, lineHeight: 1.7,
        }}>
          <li>~7.7GB of weights, plus a Python environment of its own.</li>
          <li>
            About {RESIDENT_GB}GB while it runs
            {budgetGb > 0 && ` — this machine has about ${budgetGb.toFixed(0)}GB to give`}
            {tight
              ? ", so it is paused while a render is on the GPU and resumed for "
                + "the next line."
              : "."}
          </li>
          {/* NOT decoration: the weights AND their outputs are non-commercial,
              which is a fact about what the user may do with what they make. */}
          <li style={{ color: WARN }}>
            {status?.license ?? "BreezeBlue Research — non-commercial, weights and outputs"}.
          </li>
          {!!status && !status.installed && !!status.weights_missing.length && (
            <li>{status.weights_missing.length} of {WEIGHT_FILES} files still to fetch.</li>
          )}
          <li>
            Used by the Voice tab&rsquo;s Breeze row, by an episode&rsquo;s cast
            voices, and by any voice cloned on it.
          </li>
        </ul>
      </div>
    </div>
  );
}

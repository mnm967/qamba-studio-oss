// The Speech tab's second engine — Qwen3-TTS on this machine.
//
// `BreezeSection`'s shape, sharing its shell (`voiceEngineCard`) so the two
// cards cannot drift on the behaviours that were bugs there first. What it
// does NOT share is the copy, and the copy is the whole reason both exist:
//
//   * the LICENCE is the good news here (Apache 2.0, weights and outputs)
//     where Breeze's is the caveat, so it reads green rather than amber;
//   * it is TWO checkpoints and ~9GB, more than Breeze on both counts;
//   * it CANNOT steer a line's delivery and does not perform "(sigh)" —
//     stated, because that absence is silent everywhere else.
import React from "react";
import { Download, Loader2, Mic, Play, Square, TriangleAlert } from "lucide-react";
import {
  qwenAction, qwenActive, qwenStatus, installQwen, onQwenProgress,
  remainingGb, startQwen, stopQwen, WEIGHT_FILES, type QwenStatus,
} from "../../lib/qwenLocal";
import { detectHardware, machineBudgetGb } from "../../lib/desktop";
import {
  ACCENT, Bar, INK, MUTE, OK, Pill, useEngineCard, WARN,
} from "./voiceEngineCard";

/** ~9GB resident: the pair is 4.52 + 4.54GB of weights, more than Breeze's
 *  measured 8.5 — which is why parking it around a render matters more here. */
const RESIDENT_GB = 9;

export default function QwenSection() {
  const [budgetGb, setBudgetGb] = React.useState(0);
  const { status, busy, err, prog, run } = useEngineCard<QwenStatus>({
    status: qwenStatus,
    active: qwenActive,
    onProgress: onQwenProgress,
    isStarting: (s) => Boolean(s?.starting),
  });

  React.useEffect(() => {
    void detectHardware().then((h) => setBudgetGb(machineBudgetGb(h)));
  }, []);

  const act = qwenAction(status);
  const tight = budgetGb > 0 && budgetGb < RESIDENT_GB;
  const ACTIONS: Record<string, { fn: () => Promise<unknown>; icon: React.ReactNode }> = {
    install: { fn: () => installQwen(), icon: <Download size={12} /> },
    resume: { fn: () => installQwen(), icon: <Download size={12} /> },
    start: { fn: startQwen, icon: <Play size={12} /> },
    stop: { fn: stopQwen, icon: <Square size={12} /> },
  };
  const left = status ? remainingGb(status) : 0;

  return (
    <div data-testid="qwen" style={{ marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "2px 2px 8px" }}>
        <Mic size={12} style={{ color: MUTE }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Dialogue engine · commercial-safe</span>
        <span style={{ fontSize: 11.5, color: MUTE }}>
          the same idea, under a licence you can ship
        </span>
      </div>

      <div className="ws-card" style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: INK }}>Qwen3-TTS 1.7B</span>
          {status?.foreign && <Pill tone={WARN}>already running · started outside the app</Pill>}
          {status?.ours && <Pill tone={OK}>running</Pill>}
          {status?.starting && <Pill tone={ACCENT}>loading the models</Pill>}
          {!status?.reachable && !status?.starting && status?.installed
            && <Pill tone={MUTE}>installed, not running</Pill>}
          {!status?.installed && !status?.reachable && <Pill tone={MUTE}>not installed</Pill>}
          {status?.device && (
            <span className="mono" style={{ fontSize: 10.5, color: MUTE }}>{status.device}</span>
          )}
          <div style={{ flex: 1 }} />
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
          Designs a voice from a character&rsquo;s description and speaks every line in
          it, exactly as Breeze does — and its weights and their outputs are
          Apache&nbsp;2.0, so what you make with it is yours to sell.
        </div>
        <ul style={{
          margin: "8px 0 0", padding: "0 0 0 16px", fontSize: 11,
          color: MUTE, lineHeight: 1.7,
        }}>
          {/* THE GOOD NEWS, in green, because it is the reason to choose this
              engine over the one above rather than a caveat about it. */}
          <li style={{ color: OK }}>
            {status?.license ?? "Apache 2.0 — weights and code, no usage restriction"}.
          </li>
          <li>
            ~9GB of weights across TWO checkpoints — one designs a voice, the other
            speaks in it, and neither can do the other&rsquo;s job.
          </li>
          <li>
            About {RESIDENT_GB}GB while it runs
            {budgetGb > 0 && ` — this machine has about ${budgetGb.toFixed(0)}GB to give`}
            {tight
              ? ", so it is paused while a render is on the GPU and resumed for "
                + "the next line."
              : "."}
          </li>
          {/* NOT decoration: `generate_voice_clone` takes no instruction, so a
              delivery note has nowhere to go. Someone choosing between the two
              engines is choosing this away. */}
          <li style={{ color: WARN }}>
            It cannot act a direction: a delivery note (&ldquo;weary&rdquo;,
            &ldquo;furious&rdquo;) reaches the read only through the writing, and a
            written &ldquo;(sigh)&rdquo; is dropped rather than performed. Breeze does
            both.
          </li>
          {!!status && !status.installed && !!status.weights_missing.length && (
            <li>{status.weights_missing.length} of {WEIGHT_FILES} files still to fetch.</li>
          )}
        </ul>
      </div>
    </div>
  );
}

// "Fix it" for an imported workflow.
//
// THE SCREEN'S JOB IS TO MAKE THE SPLIT VISIBLE. Almost every repair here is
// arithmetic on ComfyUI's own reply — a `value_not_in_list` carries the list of
// legal values, so "you do not have this checkpoint" is a string match, not a
// model. Only a node class nothing installed provides needs one. If the two
// looked the same in the list, a user would either distrust the exact ones or
// over-trust the guesses, so each proposal wears its confidence and an AI one
// says so.
//
// NOTHING IS APPLIED ON SIGHT. Every proposal is a checkbox, exact ones ticked
// by default and guesses not, and Apply writes the patched graph back. That is
// the difference between a fixer and something that quietly edits your work:
// the engine's own answer is worth defaulting to, a model's opinion is not.
import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, Sparkles, Stethoscope, Wrench } from "lucide-react";

import type { CustomWorkflow } from "../../lib/db/customWorkflows";
import {
  aiFix, diagnose, saveRepairs, targetEngine, type Diagnosis,
} from "../../lib/workflowFixer";
import type { Repair } from "../../lib/workflowRepair";

const INK_MUTE = "#5e6678";
const C_OK = "#6fd08c";
const C_RISK = "#e8a13a";
const C_BROKEN = "#e8734a";

const CONF: Record<Repair["confidence"], { color: string; label: string; hint: string }> = {
  exact: { color: C_OK, label: "exact", hint: "the engine's own answer — no judgement involved" },
  likely: { color: C_RISK, label: "likely", hint: "a strong match, but still a judgement" },
  guess: { color: INK_MUTE, label: "guess", hint: "offered for you to decide" },
};

export default function WorkflowRepairPanel(
  { w, onChange }: { w: CustomWorkflow; onChange: (next: CustomWorkflow) => void },
) {
  const [d, setD] = useState<Diagnosis | null>(null);
  const [busy, setBusy] = useState<"scan" | "ai" | "apply" | null>(null);
  const [pick, setPick] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [extra, setExtra] = useState<Repair[]>([]);

  const scan = useCallback(async () => {
    setBusy("scan"); setErr(null); setNote(null); setExtra([]);
    try {
      // This machine's engine when it is running, the POD's published
      // inventory otherwise — the pod is where `image_gen`/`clip_gen` execute,
      // so judging a graph only against the laptop was answering about the
      // wrong machine. Both halves come from one document; a reclass needs the
      // schema, not just the class list (see `fillFor`).
      const eng = await targetEngine();
      const got = await diagnose(w, { installed: eng?.installed, objectInfo: eng?.objectInfo,
                                      engine: eng?.engine });
      setD(got);
      // Exact repairs are the engine's own answer, so they start ticked; a
      // guess starts unticked because accepting one is a decision.
      setPick(Object.fromEntries(got.repairs.map((r) => [r.id, r.confidence === "exact"])));
      // Name the machine. A verdict is about one, and "runs here" without
      // saying where is how a green tick from the laptop stood in for the pod.
      setNote(eng
        ? `Checked against ${eng.engine.label}`
          + (eng.engine.at ? `, as it reported on ${eng.engine.at.slice(0, 10)}.` : ".")
        : "No engine answered — not this machine's, and the studio cloud has published no "
          + "inventory — so this is diagnosed from the stored failure alone. Missing node "
          + "classes cannot be checked and a node swap cannot be offered.");
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(null); }
  }, [w]);

  // Diagnosing costs nothing and needs no confirmation, so it runs on open —
  // the alternative is a panel whose first state is a button that does the
  // only thing it can do.
  useEffect(() => { void scan(); }, [scan]);

  const askAi = async () => {
    if (!d) return;
    setBusy("ai"); setErr(null); setNote(null);
    try {
      const r = await aiFix(w, d);
      setExtra(r.repairs);
      setPick((p) => ({ ...p, ...Object.fromEntries(r.repairs.map((x) => [x.id, false])) }));
      setNote([
        r.note,
        r.backend ? `asked ${r.backend}` : null,
        // A fallback is reported, never swallowed — the rule every other
        // director surface follows.
        ...(r.fellBack ?? []).map((f) => `fell back ${f.from} → ${f.to}: ${f.reason}`),
      ].filter(Boolean).join(" · ") || null);
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(null); }
  };

  const all = [...(d?.repairs ?? []), ...extra];
  const chosen = all.filter((r) => pick[r.id] && r.patch);
  const apply = async () => {
    setBusy("apply"); setErr(null);
    try {
      const res = await saveRepairs(w, chosen);
      onChange(res.workflow);
      setNote(`${res.applied.length} change(s) written`
        // Never "3 applied" having applied two: the render would then fail for
        // a reason the user believes was handled.
        + (res.skipped.length ? ` · ${res.skipped.length} could not be applied: `
          + res.skipped.map((s) => s.reason).join("; ") : "")
        + ". The workflow is a draft again — only a render proves it.");
      await scan();
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(null); }
  };

  const fixable = all.filter((r) => r.patch).length;

  return (
    <div className="ws-card ns-l1" style={{ borderRadius: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Wrench size={13} style={{ color: INK_MUTE }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Repair</span>
        <div style={{ flex: 1 }} />
        <button className="ws-actbtn" onClick={() => void scan()} disabled={!!busy}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
          {busy === "scan" ? <Loader2 size={12} className="ws-spin" /> : <Stethoscope size={12} />}
          Re-check
        </button>
      </div>

      {busy === "scan" && !d && (
        <p style={{ fontSize: 12, color: INK_MUTE, margin: 0 }}>Reading the graph…</p>
      )}

      {d && !all.length && (
        <p style={{ fontSize: 12, color: C_OK, margin: 0, display: "flex", gap: 6 }}>
          <Check size={13} /> Nothing to fix from here.
        </p>
      )}

      {all.map((r) => {
        const c = CONF[r.confidence];
        return (
          <label key={r.id} style={{
            display: "flex", gap: 9, alignItems: "flex-start", padding: "8px 0",
            borderTop: "1px solid rgba(255,255,255,0.06)",
            cursor: r.patch ? "pointer" : "default", opacity: r.patch ? 1 : 0.78,
          }}>
            <input type="checkbox" disabled={!r.patch} checked={!!pick[r.id]}
                   onChange={(e) => setPick((p) => ({ ...p, [r.id]: e.target.checked }))}
                   style={{ marginTop: 3, flex: "none" }} />
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 12.5 }}>{r.title}</span>
                <span className="mono" title={c.hint} style={{
                  fontSize: 9.5, padding: "1px 5px", borderRadius: 5, color: c.color,
                  border: `1px solid ${c.color}55`,
                }}>{c.label}</span>
                {r.ai && (
                  <span className="mono" title="written by a model, checked against the engine"
                        style={{ fontSize: 9.5, padding: "1px 5px", borderRadius: 5,
                                 color: "#a97bff", border: "1px solid #a97bff55",
                                 display: "inline-flex", alignItems: "center", gap: 3 }}>
                    <Sparkles size={8} /> AI
                  </span>
                )}
                {!r.patch && (
                  <span className="mono" style={{ fontSize: 9.5, color: INK_MUTE }}>advice only</span>
                )}
              </span>
              <span style={{ display: "block", fontSize: 11.5, color: INK_MUTE, marginTop: 2 }}>
                {r.detail}
              </span>
              {r.action?.install && (
                <a className="ws-actbtn" href={r.action.install.url} target="_blank" rel="noreferrer"
                   style={{ display: "inline-flex", gap: 5, fontSize: 11, marginTop: 5 }}>
                  {r.action.install.name}
                </a>
              )}
            </span>
          </label>
        );
      })}

      <div style={{ display: "flex", gap: 7, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button className="ws-primary" disabled={!chosen.length || !!busy} onClick={() => void apply()}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          {busy === "apply" ? <Loader2 size={12} className="ws-spin" /> : <Check size={12} />}
          Apply {chosen.length || ""}
        </button>
        {/* Offered only where a model could add something arithmetic could not,
            and only with an engine to validate its answer against. A button
            that spends money to restate what the engine already said is how a
            fixer stops being trusted. */}
        {d?.aiAvailable && (
          <button className="ws-actbtn" disabled={!!busy} onClick={() => void askAi()}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
            {busy === "ai" ? <Loader2 size={12} className="ws-spin" /> : <Sparkles size={12} />}
            Ask AI about {d.faults.filter((f) => f.kind === "missing_class").length} unknown node(s)
          </button>
        )}
        {d && fixable === 0 && all.length > 0 && (
          <span style={{ fontSize: 11.5, color: INK_MUTE, display: "inline-flex", gap: 5 }}>
            <AlertTriangle size={12} style={{ color: C_RISK }} />
            Nothing here can be changed from the studio — these need ComfyUI or an install.
          </span>
        )}
      </div>

      {note && <p style={{ fontSize: 11.5, color: INK_MUTE, margin: "8px 0 0" }}>{note}</p>}
      {err && (
        <div style={{
          marginTop: 8, fontSize: 11.5, padding: "7px 9px", borderRadius: 9,
          color: "#f0b9a4", background: "rgba(232,115,74,0.09)",
          border: `1px solid ${C_BROKEN}44`,
        }}>{err}</div>
      )}
    </div>
  );
}

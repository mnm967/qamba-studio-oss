// "What the plan draws for you" — the wizard's step-1 card.
//
// The decision it carries is `src/lib/planAuto.ts`; everything here is layout,
// and /ui/wizauto is where it is looked at.
//
// WHY IT IS ON STEP 1 rather than beside the buttons it defers to. The plan is
// launched from here and queues everything the moment it lands, so by the time
// the Cast & world step is on screen the jobs have been running for a minute.
// A control for that has to be reachable BEFORE the plan, which is the one
// screen it can be on.
//
// WHY IT IS THREE SWITCHES rather than one "review first" toggle. They cost
// wildly different things — a voice clip is seconds and a panel per shot is
// dozens of renders — and the common answer is not all-or-nothing: sheets are
// what the rest is anchored on, so drawing those while you read the storyboard
// is a perfectly good middle. The ladder (panels need sheets) is enforced in
// `toggleAuto`, so a combination the worker refuses cannot be set here.
import React from "react";
import { Check, Sparkles } from "lucide-react";
import { AUTO_STEPS, autoBlocked, autoSummary, type AutoKey } from "../../lib/planAuto";

export default function PlanAutoCard({
  on, onToggle, tier, disabled,
}: {
  on: ReadonlySet<AutoKey>;
  onToggle: (k: AutoKey) => void;
  /** Full auto draws everything whatever these say, so it says so rather than
   *  leaving three switches that look live and are not. */
  tier: 1 | 2;
  /** the storyboard is already planned — these are spent */
  disabled?: boolean;
}) {
  const forced = tier === 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="ws-mlabel" style={{ fontSize: 10.5, color: "#5e6678" }}>
        When the plan lands
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {AUTO_STEPS.map((s) => {
          const blocked = forced ? null : autoBlocked(s, on);
          const checked = forced || on.has(s.id);
          const off = !!disabled || forced || !!blocked;
          return (
            <button key={s.id} type="button" disabled={off}
                    title={disabled
                      ? "the storyboard is already planned — draw these from the "
                        + "Cast & world and Storyboard steps"
                      : forced ? "Full auto renders without a review, so it draws everything"
                        : blocked ? `${s.label} ${blocked}`
                          : checked ? `Don't draw ${s.label.toLowerCase()} automatically`
                            : `Draw ${s.label.toLowerCase()} as soon as the plan lands`}
                    onClick={() => onToggle(s.id)}
                    style={{
                      display: "flex", alignItems: "flex-start", gap: 9, width: "100%",
                      padding: "9px 10px", borderRadius: 12, textAlign: "left",
                      cursor: off ? "default" : "pointer",
                      opacity: off && !checked ? .5 : 1,
                      border: `1px solid ${checked ? "rgba(90,162,255,.35)" : "rgba(255,255,255,.08)"}`,
                      background: checked ? "rgba(90,162,255,.1)" : "rgba(255,255,255,.02)",
                    }}>
              <span style={{ width: 15, height: 15, borderRadius: 5, flexShrink: 0, marginTop: 1,
                             display: "grid", placeItems: "center",
                             border: `1px solid ${checked ? "rgba(90,162,255,.7)" : "rgba(255,255,255,.2)"}`,
                             background: checked ? "rgba(90,162,255,.3)" : "transparent",
                             color: "#dfe5f1" }}>
                {checked && <Check size={10} />}
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 12.5, fontWeight: 600,
                               color: checked ? "#bfd8ff" : "#9aa4b6" }}>
                  {s.label}
                </span>
                <span style={{ display: "block", fontSize: 11, lineHeight: 1.45,
                               color: "#5e6678", marginTop: 2 }}>
                  {blocked ?? s.blurb}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 7, fontSize: 11, lineHeight: 1.5, color: "#5e6678" }}>
        <Sparkles size={12} style={{ flexShrink: 0, marginTop: 2, opacity: .7 }} />
        <span>
          {forced
            ? "Full auto renders without stopping, so it draws all three."
            : autoSummary(on)}
        </span>
      </div>
    </div>
  );
}

// The LLM backend list, grouped by plane — for use inside any Dropdown body.
//
// THE SHAPE IS `TieredModelMenu`'S, and for the same reason: this is the second
// picker in the app that has to answer "where does it run and who pays", and
// the first one learned that a flat list puts "your Anthropic key" next to "the
// studio's subscription" with nothing but the word "key" between them. It also
// learned the cost of letting each surface build its own: the wizard's copy
// never grew tiers, never grew the blocked states, and went on offering rows
// that answer 403 long after the dock stopped.
//
// So the rows live here and the two surfaces own only their trigger — a dock
// chip and a settings row, which is exactly the split `TieredModelMenu`
// documents for its own five callers.
//
// It reads the ROLE and the KEYS itself rather than taking them as props.
// Those are the two inputs `backendBlocked` needs, and a prop is a call site
// free to forget one — which is how a picker ends up offering a member the
// studio's own subscription.
import React from "react";
import { Check } from "lucide-react";
import { TIER_META, TIER_ORDER, type ModelTier } from "../../lib/localModels";
import { backendBlocked, availableBackends, type DirectorBackend } from "../../lib/director";
import { useIsAdmin } from "../../lib/auth";
import { useByok } from "../../hooks/useByok";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { TierIcon } from "./TieredModelMenu";

/** The short name for a closed chip — the menu's own `model`, not the long
 *  label, so a shut picker says the same thing the open one does. */
export function backendShort(id: string | undefined): string {
  return availableBackends().find((b) => b.id === id)?.model ?? "Auto";
}

/** What sits under that name on the chip: the connection, which is the half a
 *  shut picker most needs ("Subscription" vs "your key"). */
export function backendTierLabel(id: string | undefined): string {
  return availableBackends().find((b) => b.id === id)?.connection ?? "";
}

export default function BackendMenu({
  value, onPick, close, disabled,
}: {
  value: string | undefined;
  onPick: (id: string) => void;
  /** the Dropdown's own close callback — a pick should shut the menu */
  close?: () => void;
  /** the whole list is inert (the wizard's mature mode pins the backend) */
  disabled?: boolean;
}) {
  const isAdmin = useIsAdmin();
  const { keyed } = useByok();
  const ws = useWorkspaceStore();
  const backends = availableBackends();

  const row = (b: DirectorBackend) => {
    const blocked = disabled ? { why: "" } : backendBlocked(b, { admin: isAdmin, keyed });
    return (
      <button key={b.id} title={blocked?.why || b.hint}
              className={"ws-menu-row ws-modelpick" + (value === b.id ? " on" : "")}
              style={blocked ? { opacity: 0.5 } : undefined}
              // A row whose fix is the USER'S own stays clickable and goes to
              // the screen that performs it; a sentence naming a fix with
              // nowhere to go is worse than no row.
              disabled={!!blocked && !("fix" in blocked && blocked.fix)}
              onClick={() => {
                if (blocked && "fix" in blocked && blocked.fix === "keys") {
                  close?.();
                  ws.openModal({ kind: "engine", tab: "keys" });
                  return;
                }
                if (blocked) return;
                close?.(); onPick(b.id);
              }}>
        <span className="top">
          <span className="nm">{b.model}</span>
          <span className="chip">{b.connection}</span>
          {b.flag && <span className="flag">{b.flag}</span>}
          {value === b.id && !blocked
            && <Check size={13} style={{ color: "#58a6ff", flex: "none" }} />}
        </span>
        <span className="hint">{blocked?.why || b.hint}</span>
      </button>
    );
  };

  return (
    <>
      <div className="ws-menu-label">Model</div>
      {/* `auto` is a ROUTER rather than a place, so it stays ungrouped at the
          top — it is the answer to "just pick for me", not a fourth plane. */}
      {backends.filter((b) => !b.tier).map(row)}
      {TIER_ORDER.map((t: ModelTier) => {
        const group = backends.filter((b) => b.tier === t);
        if (!group.length) return null;
        return (
          <React.Fragment key={t}>
            <div className="gd-tier">
              <TierIcon tier={t} />
              <b>{TIER_META[t].label}</b>
              <em>{t === "cloud" && !isAdmin ? "coming soon" : TIER_META[t].cost}</em>
            </div>
            {group.map(row)}
          </React.Fragment>
        );
      })}
    </>
  );
}

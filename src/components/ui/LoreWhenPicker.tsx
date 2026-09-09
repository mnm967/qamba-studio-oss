// When a lore fact is true, and when the audience learns it.
//
// The design problem: three fields is the honest model (see lib/loreTime.ts for
// why one tag cannot express a retcon) and three dropdowns is a form nobody
// fills in. So the common case is ONE choice — "always true" or an episode —
// and the two that only matter for retcons and superseded facts stay folded
// away behind a link that names what they are for.
//
// Picking an episode sets `from` AND `revealed` together, because an ordinary
// fact is established when it is shown. Separating them is the deliberate act,
// which is right: only a reader who knows the story can tell a retcon from an
// ordinary fact, so it should take a decision rather than a default.
import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import Dropdown from "./Dropdown";
import {
  EVERGREEN, isEvergreen, isRetcon, episodeOrder, whenLabel, type LoreWhen,
} from "../../lib/loreTime";

export interface EpisodeRef { id: string; idx: number; code?: string | null; title?: string | null }

const epName = (e: EpisodeRef) => e.code || `Ep${e.idx + 1}`;

function EpisodeMenu({
  episodes, value, onPick, allowNone, noneLabel, width = 240,
}: {
  episodes: EpisodeRef[];
  value: string | null;
  onPick: (id: string | null) => void;
  allowNone?: boolean;
  noneLabel?: string;
  width?: number;
}) {
  const cur = episodes.find((e) => e.id === value) ?? null;
  return (
    <Dropdown width={width}
      trigger={({ toggle }) => (
        <button className="ws-ghost" onClick={toggle}
                style={{ height: 30, minWidth: 118, justifyContent: "space-between", padding: "0 10px" }}>
          <span style={{ fontSize: 12 }}>
            {cur ? epName(cur) : (noneLabel ?? "—")}
          </span>
          <ChevronDown size={12} />
        </button>
      )}>
      {(close) => (
        <>
          {allowNone && (
            <button className={"ws-menu-row" + (value ? "" : " on")}
                    onClick={() => { close(); onPick(null); }}>
              {noneLabel ?? "—"}
            </button>
          )}
          {episodes.map((e) => (
            <button key={e.id} className={"ws-menu-row" + (e.id === value ? " on" : "")}
                    onClick={() => { close(); onPick(e.id); }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 12.5 }}>{epName(e)}</span>
                {e.title && (
                  <span style={{ display: "block", fontSize: 10.5, color: "#5e6678",
                                 overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {e.title}
                  </span>
                )}
              </span>
            </button>
          ))}
        </>
      )}
    </Dropdown>
  );
}

export default function LoreWhenPicker({
  value, episodes, onChange, disabled,
}: {
  value: LoreWhen;
  episodes: EpisodeRef[];
  onChange: (next: LoreWhen) => void;
  disabled?: boolean;
}) {
  const order = episodeOrder(episodes);
  const retcon = isRetcon(value, order);
  const superseded = !!value.until;
  // Open by default when the fact already uses them — otherwise the timing on
  // screen would not explain the chip beside it.
  const [open, setOpen] = useState(retcon || superseded);
  const evergreen = isEvergreen(value);

  if (!episodes.length) {
    return (
      <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
        no episodes yet — lore applies to everything
      </span>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button className={"ws-pill" + (evergreen ? " on" : "")} disabled={disabled}
                title="A rule that does not change — always in the planner's context"
                style={evergreen
                  ? { borderColor: "rgba(111,208,140,.5)", background: "rgba(111,208,140,.12)", color: "#6fd08c" }
                  : undefined}
                onClick={() => onChange(EVERGREEN)}>
          Always true
        </button>
        <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>or from</span>
        <EpisodeMenu episodes={episodes} value={value.from} allowNone noneLabel="the start"
                     onPick={(id) => onChange(
                       // One click sets both: an ordinary fact is established
                       // when it is shown. `revealed` only diverges deliberately.
                       { ...value, from: id, revealed: id })} />
        {!evergreen && (
          <button className="ws-microbtn" onClick={() => setOpen((o) => !o)}>
            {open ? "fewer" : "retcon or expires?"}
          </button>
        )}
      </div>

      {open && !evergreen && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 10.5, color: "#5e6678", minWidth: 92 }}>
              revealed in
            </span>
            <EpisodeMenu episodes={episodes} value={value.revealed} allowNone
                         noneLabel="never stated"
                         onPick={(id) => onChange({ ...value, revealed: id })} />
            {retcon && (
              <span className="mono" style={{ fontSize: 10, color: "#e8c268" }}>
                retcon — true earlier than it is known
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 10.5, color: "#5e6678", minWidth: 92 }}>
              stops being true
            </span>
            <EpisodeMenu episodes={episodes} value={value.until} allowNone noneLabel="never"
                         onPick={(id) => onChange({ ...value, until: id })} />
          </div>
          <div style={{ fontSize: 11, lineHeight: 1.6, color: "#5e6678" }}>
            {retcon
              ? "Before it is revealed, the world behaves as though this holds — events and "
                + "consequences follow it — but no character may state, explain or discover it."
              : "Set “revealed in” later than “from” for a twist that was always true and only "
                + "becomes known later. Set “stops being true” for something that a later "
                + "episode undoes — “she doesn’t know it’s her power yet”."}
          </div>
        </div>
      )}

      <span className="mono" style={{ fontSize: 10.5, color: evergreen ? "#6fd08c" : "#8fc2ff" }}>
        {whenLabel(value, episodes)}
      </span>
    </div>
  );
}

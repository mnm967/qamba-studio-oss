// The model list, grouped by WHERE IT RUNS — one implementation, five surfaces.
//
// GenComposer grew this because a flat list could not say the one thing you
// need first: whether a pick costs GPU time on the shared pod, nothing at all
// on this machine, or money per render at a provider. Everywhere else kept its
// own flat dropdown — ProjectSettingsModal's `ModelPicker`, ContextPanel's
// `ModelPickerDropdown`, and the two panel modals — so the same catalog read
// four different ways, and only one of them told you a row was hosted.
//
// The tier is DERIVED (`tierOf`), never stored: `model_catalog.provider ===
// "local"` has meant the studio's POD since before the desktop app existed, so
// the id is what separates a local pick from a cloud one. See localModels.ts.
import React from "react";
import { Check, Cloud, Download, Globe, Laptop, Sliders, Sparkles } from "lucide-react";
import { TIER_META, TIER_ORDER, tierOf, qualityTiers, rowBlocked,
         type ModelTier, type Quality } from "../../lib/localModels";
// Re-exported so the three components importing it from here are untouched by
// the move — it is pure logic and lives beside `tierOf`, which it reads.
export { rowBlocked };
import type { ModelCatalogRow } from "../../lib/db/types";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";

// Re-exported so a caller needs one import for the menu and its knob.
export { qualityTiers, QUALITY_TIERS, type Quality } from "../../lib/localModels";

/** Green for your own hardware, amber for your own card, blue for a provider
 *  no key here can reach yet. Lives here so the header icon is the DEFAULT
 *  rather than something four of five callers forgot to pass. */
export const TIER_TINT: Record<ModelTier, string> = {
  local: "#54c08a", byok: "#ffb454", cloud: "#5aa2ff",
};

export function TierIcon({ tier }: { tier: ModelTier | null }) {
  if (!tier) return <Sparkles size={12} />;
  const C = tier === "local" ? Laptop : tier === "byok" ? Globe : Cloud;
  return <C size={12} style={{ color: TIER_TINT[tier], flex: "none" }} />;
}


/** What a row says about itself under its name. */
function rowNote(m: ModelCatalogRow): string {
  const blocked = rowBlocked(m);
  if (blocked) return blocked.why;
  const refs = Number(m.capabilities?.multiRef ?? 0);
  const loras = Object.keys((m.capabilities?.styleLoras ?? {}) as object).length;
  // WHICH WEIGHTS, when they are not the ones the map names. `apply_rungs`
  // lets a machine holding Klein 4B at Q4_K_M satisfy an entry declaring the
  // fp8 — which is the point — but a row reading "on this machine" over a
  // substitution nobody was told about is the failure this codebase names more
  // than any other. Absent for every row rendering on its declared rung, which
  // is most of them.
  const rung = (m.capabilities as { desktopRung?: string } | undefined)?.desktopRung;
  return [
    (m.modes ?? []).join(" · ") || null,
    rung ? `on your ${rung}` : null,
    refs ? `up to ${refs} references` : null,
    loras ? `${loras} LoRA${loras === 1 ? "" : "s"}` : null,
    m.capabilities?.vramGb ? `~${m.capabilities.vramGb}GB` : null,
    // NO PRICE. `pricing` is still on the row and still books the ledger the
    // Costs page reads — it simply stops being a thing every picker in the app
    // puts under a model's name.
  ].filter(Boolean).join(" · ") || m.provider;
}

/**
 * The grouped rows themselves, for use inside any Dropdown/menu body.
 *
 * Deliberately NOT a Dropdown: the five callers differ entirely in their
 * trigger (a ghost button, a settings row, a compact pill) and wrapping one
 * here would mean five props to un-style it again. They own the trigger; this
 * owns the list.
 */
export default function TieredModelMenu({
  models, value, onPick, close, children, icon, noteFor, quality, onQuality,
}: {
  models: ModelCatalogRow[];
  value: string | null | undefined;
  onPick: (id: string) => void;
  /** the Dropdown's close callback — a pick should shut the menu */
  close?: () => void;
  /** trailing content (engine states, hints) rendered after the groups */
  children?: React.ReactNode;
  icon?: (tier: ModelTier) => React.ReactNode;
  /** Extra per-row detail appended to the note — how a caller keeps its own
   *  affordance (PanelRegenModal's "drew this one") without a second menu. */
  noteFor?: (m: ModelCatalogRow) => string | null | undefined;
  /** Render quality for the rows that expose one. Omit onQuality to hide the
   *  control entirely — a knob that cannot change the render is worse than no
   *  knob, the same rule the negative prompt follows. */
  quality?: Quality | null;
  onQuality?: (q: Quality) => void;
}) {
  // Which row has its quality picker open. Inline under the row rather than a
  // nested Dropdown: this menu is already inside one portalled popover, and a
  // second one anchored to a row inside a scrolling menu is the clipping bug
  // `.ns-l3`'s backdrop-filter causes elsewhere in this app.
  const [openQ, setOpenQ] = React.useState<string | null>(null);
  const ws = useWorkspaceStore();
  const grouped = TIER_ORDER
    .map((t) => ({ tier: t, rows: models.filter((m) => tierOf(m) === t) }))
    .filter((g) => g.rows.length);

  return (
    <>
      {grouped.map((g) => (
        <React.Fragment key={g.tier}>
          <div className="gd-tier">
            {icon ? icon(g.tier) : <TierIcon tier={g.tier} />}
            <b>{TIER_META[g.tier].label}</b>
            {/* NO `where` HERE. It is a phrase ("a provider, on your key") in a
                row that is mostly chip, so in a 260px menu it wrapped to four
                lines and pushed the chip off the end. It still reads well as a
                TOOLTIP, which is where the other callers use it; the blurb
                under this header already says the same thing in a line that
                has room for it. */}
            <em>{TIER_META[g.tier].cost}</em>
          </div>
          <div className="gd-tierblurb">{TIER_META[g.tier].blurb}</div>
          {g.rows.map((m) => {
            const blocked = rowBlocked(m);
            // A row that cannot be picked gets no quality control: the tier it
            // would render at is not a choice anyone can make yet, and the
            // "· Low" it appends to the name reads as a live setting.
            const qs = onQuality && !blocked ? qualityTiers(m) : [];
            const q = quality ?? "low";
            return (
              <React.Fragment key={m.id}>
                <button className={"ws-menu-row" + (m.id === value ? " on" : "")}
                        // A row whose fix is the USER'S own stays clickable and
                        // goes to the screen that performs it. Disabling it
                        // would make "add your key" a sentence with nowhere to
                        // go, which is the refusal this rework exists to end.
                        disabled={!!blocked && !blocked.fix}
                        style={blocked ? { opacity: 0.5 } : undefined}
                        onClick={() => {
                          if (blocked?.fix) {
                            // Every fix is a tab of the engine window, and the
                            // sentence above named which one. Dispatching on
                            // the value rather than listing them is what keeps
                            // a new fix from silently becoming a dead click.
                            close?.();
                            ws.openModal({ kind: "engine", tab: blocked.fix });
                            return;
                          }
                          if (blocked) return;
                          close?.(); onPick(m.id);
                        }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 12.5 }}>
                      {m.display_name}
                      {/* The tier rides the NAME, so a shut menu still says
                          which one is in force — "GPT Image 2" and "GPT Image
                          2 · High" are a 6x price difference. */}
                      {qs.length > 0 && (
                        <span style={{ color: "#ffb454" }}>
                          {" · "}{q[0].toUpperCase() + q.slice(1)}
                        </span>
                      )}
                    </span>
                    <span className="mono" style={{ display: "block", fontSize: 10, color: "#5e6678" }}>
                      {/* A blocked row says ONE thing: what is wrong. The
                          caller's own note ("your key") beside "add your
                          openai key" is the same fact twice. */}
                      {blocked ? blocked.why
                        : [rowNote(m), noteFor?.(m)].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {/* Opens the tier picker WITHOUT selecting the model or
                      shutting the menu — hence stopPropagation on a control
                      nested in a button. */}
                  {qs.length > 0 && (
                    <span role="button" tabIndex={0} title="Render quality"
                          className="tm-qbtn" aria-label={`Quality for ${m.display_name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenQ(openQ === m.id ? null : m.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.stopPropagation(); e.preventDefault();
                              setOpenQ(openQ === m.id ? null : m.id);
                            }
                          }}>
                      <Sliders size={11} />
                    </span>
                  )}
                  {/* WHAT KIND OF UNAVAILABLE THIS IS, at a glance.
                      Every blocked row is greyed and carries a sentence, so
                      from across the menu a model that needs 13GB fetching
                      looks exactly like one that is coming soon and one that
                      wants a key — and the download is the only one of the
                      three the reader can act on right now. `models` is
                      precisely "go and fetch weights": a local family with
                      none on disk (`localOfferRows`), a bundled row the
                      catalogue can fetch (`markFor`), an image entry the
                      desktop map is short a file for (`imageVerdict`). The
                      other fixes are not downloads and get no icon.

                      DECORATIVE, not a second control: the whole row is
                      already the button and already opens the Models tab, so
                      a nested click target here would be two ways to do one
                      thing and one more place for a stopPropagation bug. */}
                  {blocked?.fix === "models" && (
                    <span title="Download it in the engine window"
                          style={{ display: "flex", flex: "none" }}>
                      <Download size={12} style={{ color: TIER_TINT.local }} />
                    </span>
                  )}
                  {m.id === value && <Check size={12} style={{ color: "#5aa2ff", flex: "none" }} />}
                </button>
                {openQ === m.id && qs.length > 0 && (
                  <div className="tm-qrow">
                    {qs.map((t) => (
                      <button key={t} className={"ws-pillbtn" + (t === q ? " on" : "")}
                              onClick={(e) => {
                                e.stopPropagation();
                                onQuality?.(t);
                                setOpenQ(null);
                              }}>{t}</button>
                    ))}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </React.Fragment>
      ))}
      {children}
    </>
  );
}

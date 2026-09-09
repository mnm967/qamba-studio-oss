// The one-shot wizard's model cards, grouped by WHERE THEY RUN.
//
// One component, two pickers (video and voice), because the question is the
// same one and answering it twice is how they came to disagree: the flat lists
// this replaces each carried a hand-written "studio cloud" per row, which on
// the desktop was wrong for three of the five video rows and for Breeze.
//
// PRESENTATIONAL ONLY. Every decision — which tier a row is on, whether it can
// be picked, and the sentence when it cannot — is `wizardModels.ts`, which is
// pure and tested against machines this repo cannot produce on demand. What is
// here is the layout, and `/ui/wizmodels` is where it is looked at.
import React from "react";
import { TIER_ORDER, TIER_META, type ModelTier } from "../../lib/localModels";
import { TierIcon } from "../ui/TieredModelMenu";
import type { WizardBlock, WizardOffer } from "../../lib/wizardModels";

/** Where a refusal's fix lives, as the button that goes there. Naming the
 *  DESTINATION rather than the problem — "download it" beside "not downloaded
 *  yet" is the same fact twice, and a button labelled with the fault reads as
 *  a warning rather than as somewhere to go. */
const FIX_LABEL: Record<NonNullable<WizardBlock["fix"]>, string> = {
  engine: "Set up the engine",
  models: "Download it",
  // THE DESTINATION, not the engine: `onFix` opens the engine window's SPEECH
  // TAB, which hosts every local speech engine — so naming one of them put
  // "Set up Breeze" under a refusal about Qwen, which is the button pointing
  // at the wrong thing on a card that had just named the right one.
  speech: "Set up speech",
  keys: "Add a key",
};

export default function WizardModelPicker({
  label, offers, value, onPick, onFix, admin, blurbs,
}: {
  /** the `.ws-mlabel` above the whole group ("Video model") */
  label: string;
  offers: WizardOffer[];
  value: string;
  onPick: (id: string) => void;
  /** open the engine window on the tab that performs a refusal's fix */
  onFix: (tab: NonNullable<WizardBlock["fix"]>) => void;
  /**
   * Whether the studio's own account is this user's to spend.
   *
   * A PROP here, unlike `TieredModelMenu`'s own `useIsAdmin()`. That component
   * is the picker for nine surfaces, where a prop is nine call sites free to
   * forget it; this one has two, both in a modal that already holds the
   * answer — and `/ui/wizmodels` needs to show both accounts side by side,
   * which a hook read from a session it does not have cannot do.
   */
  admin: boolean;
  /**
   * What each section says under its heading, where the shared one is wrong.
   *
   * `TIER_META`'s blurbs are written for MODEL rows — "Your ComfyUI and your
   * Ollama" is exactly right over a checkpoint and names two engines that have
   * nothing to do with recording a line. A picker whose section headings
   * describe the wrong software is the same lie the per-row "studio cloud"
   * was, one level up.
   */
  blurbs?: Partial<Record<ModelTier, string>>;
}) {
  const groups = TIER_ORDER
    .map((tier) => {
      const rows = offers.filter((o) => o.tier === tier);
      // A REFUSAL THE WHOLE SECTION SHARES IS SAID ONCE, on the heading. Every
      // row of the studio's cloud is refused to a member for the same reason,
      // and to a local project for another — repeated per row that is the same
      // grey sentence two and three times, in place of what each model is.
      const all = rows.length > 0 && rows.every((o) => o.blocked?.tier);
      return { tier, rows, tierBlock: all ? rows[0].blocked! : null };
    })
    .filter((g) => g.rows.length);

  return (
    <div data-picker={label} style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <span className="ws-mlabel" style={{ fontSize: 10.5, color: "#5e6678" }}>{label}</span>
      {groups.map((g) => (
        <React.Fragment key={g.tier}>
          <div className="wz-tier">
            <TierIcon tier={g.tier} />
            <b>{TIER_META[g.tier].label}</b>
            <span style={{ flex: 1 }} />
            {/* The studio's cloud is real and is not a member's to spend yet,
                so the chip says WHEN rather than what it would cost — said on
                the HEADER because it is true of the whole section, which is
                also what stops it burying what each row is. */}
            {/* THE ACCOUNT DECIDES THIS, not whether every row happens to be
                refused: a member whose own key already unlocked one row is
                still not able to spend the studio's, and a chip reading
                "studio account" there says the opposite. */}
            <em className={g.tier === "cloud" && !admin ? "soon" : undefined}>
              {g.tier === "cloud" && !admin
                ? (g.tierBlock?.chip ?? "coming soon")
                : TIER_META[g.tier].cost}
            </em>
          </div>
          <div className="wz-tierblurb">{blurbs?.[g.tier] ?? TIER_META[g.tier].blurb}</div>
          {/* Only where the chip could not carry it. "Coming soon" is three
              words and is already up there; "the pod cannot see a project that
              lives on this disk" is not, and it is the most important sentence
              on the screen for the person it applies to. */}
          {g.tierBlock && !g.tierBlock.chip && g.tierBlock.why && (
            <div className={"wz-why" + (g.tierBlock.fix ? " fixable" : "")}
                 style={{ margin: "0 2px 2px" }}>
              <span style={{ flex: 1, minWidth: 0 }}>{g.tierBlock.why}</span>
              {g.tierBlock.fix && (
                <button className="wz-fix" type="button"
                        onClick={() => onFix(g.tierBlock!.fix!)}>
                  {FIX_LABEL[g.tierBlock.fix]}
                </button>
              )}
            </div>
          )}
          {g.rows.map((o) => (
            <Row key={o.pick} o={o} on={o.pick === value}
                 onPick={() => onPick(o.pick)} onFix={onFix} />
          ))}
        </React.Fragment>
      ))}
    </div>
  );
}

function Row({ o, on, onPick, onFix }: {
  o: WizardOffer; on: boolean;
  onPick: () => void;
  onFix: (tab: NonNullable<WizardBlock["fix"]>) => void;
}) {
  const note = o.blocked;
  const fix = note?.fix;
  return (
    <label className={"wz-card" + (on ? " on" : "") + (o.blocked ? " off" : "")}
           data-model={o.id} data-tier={o.tier} data-pick={o.pick}
           data-blocked={o.blocked ? "1" : undefined}
           // A BLOCKED CARD IS INERT, and its fix is the button rather than
           // the card. `TieredModelMenu` sends a whole blocked ROW to the fix
           // because a 34px menu row has no room for a control; a card with a
           // radio in it reads as "select me", and navigating away from a
           // modal the user was choosing in is not what that gesture means.
           onClick={() => { if (!o.blocked) onPick(); }}>
      <span className="wz-radio">{on && <i />}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="wz-name">
          <b>{o.name}</b>
          <span>{o.price}</span>
        </span>
        <span className="wz-blurb">{o.blurb}</span>
        {note && note.why && !note.tier && (
          <span className={"wz-why" + (fix ? " fixable" : "")}>
            <span style={{ flex: 1, minWidth: 0 }}>{note.why}</span>
            {fix && (
              <button className="wz-fix" type="button"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onFix(fix); }}>
                {FIX_LABEL[fix]}
              </button>
            )}
          </span>
        )}
      </span>
    </label>
  );
}

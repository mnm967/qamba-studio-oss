// The voices bar on the wizard's cast & world step — `CastWorldRefsBar`'s twin,
// and deliberately its twin down to the class names.
//
// WHAT IT REPLACED: nothing, which was the problem. A character's voice was
// synthesized by `plan_storyboard` the moment the plan landed, in whatever
// engine `resolve_provider` happened to settle on, and the only way to get a
// different one was to re-plan the episode. On a machine with no local speech
// service and no ElevenLabs key that meant an OpenAI preset — and the preset
// is repeated into every block of the episode as the character's timbre
// anchor, so it is one of the two or three decisions on this screen that is
// cheap now and expensive after the blocks render.
//
// So it is the same shape as the sheets bar above it, for the same reason: the
// count leads, the names are chips that open their entry (where a voice can be
// uploaded or re-rolled one at a time), and the ENGINE rides in the bar,
// because the engine is what the button spends.
//
// ONE ENGINE FOR THE WHOLE CAST, and that is not tidiness. `bible_entry_id`
// makes each clip the character's anchor and the reviewer's speaker verifier
// baselines every take against it — a cast recorded half on ElevenLabs and
// half on OpenAI is a similarity score that means two different things inside
// one episode. So this writes the same `dialogueProvider` the Models step
// does, through the same picker, rather than offering a second opinion.
//
// It takes what it RENDERS rather than the wizard's world, the rule `TakeRow`
// and the sheets bar already follow: the states worth looking at — some
// missing, some recording, all done, an engine that cannot record here — are
// minutes apart on the real screen and a prop away in /ui/castworld.
import React from "react";
import { AlertTriangle, Check, ChevronDown, Loader2, Mic } from "lucide-react";
import WizardModelPicker from "./WizardModelPicker";
import type { WizardBlock, WizardOffer } from "../../lib/wizardModels";
import type { SpeakingRole } from "../../lib/voiceRefs";
import { baseName } from "../../lib/voiceRefs";

/** How many names are shown before the rest are counted — the sheets bar's
 *  number, so the two read as one list of chores rather than two designs. */
export const VOICE_CHIPS = 6;

export default function CastWorldVoiceBar({
  pending, drawing, done, engine, engineName, blocked, offers, onPick, onFix,
  admin, blurbs, queuing, onGenerate, onOpen,
}: {
  /** speaks, has no clip, and has nothing in flight — what the button records */
  pending: SpeakingRole[];
  /** speaks, no clip, job already queued. Counted, never re-queued. */
  drawing: number;
  /** speaks and already has a clip */
  done: number;
  engine: string;
  engineName: string;
  /** why this engine cannot record on this machine, or null */
  blocked: string | null;
  offers: WizardOffer[];
  onPick: (id: string) => void;
  onFix: (tab: NonNullable<WizardBlock["fix"]>) => void;
  admin: boolean;
  blurbs?: Record<string, string>;
  queuing: boolean;
  onGenerate: () => void;
  onOpen: (entryId: string) => void;
}) {
  const [openPick, setOpenPick] = React.useState(false);
  const n = pending.length;
  const total = n + drawing + done;
  // Nobody speaks: a bar about recording voices over a silent film is noise,
  // and the empty state that says "every character has a voice" would be a
  // sentence about nobody.
  if (!total) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div className={`ws-wizard-refs${n && !blocked ? " warn" : ""}`}
           style={blocked ? { borderColor: "rgba(255,128,128,.32)",
                              background: "rgba(255,128,128,.07)" } : undefined}>
        <div className="ws-wizard-refs-say">
          {blocked ? <AlertTriangle size={15} className="ic" style={{ color: "#ff8080" }} />
            : n > 0 ? <Mic size={15} className="ic" />
            : drawing > 0 ? <Loader2 size={15} className="ic ns-spin" />
            : <Check size={15} className="ic" />}
          <div className="ws-wizard-refs-copy">
            <div className="t" style={blocked ? { color: "#ffb3b3" } : undefined}>
              {n > 0
                ? `${n} of ${total} speaking character${total === 1 ? "" : "s"} `
                  + `${n === 1 ? "has" : "have"} no voice yet`
                : drawing > 0 ? `${drawing} voice${drawing === 1 ? "" : "s"} recording`
                : `All ${total} speaking character${total === 1 ? "" : "s"} have a voice.`}
              {n > 0 && drawing > 0 && <span className="also"> · {drawing} already recording</span>}
            </div>
            <div className="d">
              {blocked
                ? `${engineName} can't record here — ${blocked}.`
                : n > 0
                  ? "A timbre clip is what every block hears that character as. Without "
                    + "one the model invents a voice per block, and a voice settled after "
                    + "the blocks render means re-rendering them."
                  : drawing > 0 ? "The cards fill in as they land."
                    : "Every line in the episode will be heard in these."}
            </div>
            {n > 0 && (
              <div className="ws-wizard-refs-names">
                {pending.slice(0, VOICE_CHIPS).map((r) => (
                  <button key={r.entry.id} type="button"
                          title={`Open ${baseName(r.entry.name)} — describe how they `
                               + `sound, upload a recording, or record just this one`}
                          onClick={() => onOpen(r.entry.id)}>
                    {baseName(r.entry.name)}
                  </button>
                ))}
                {n > VOICE_CHIPS && (
                  <span className="more"
                        title={pending.slice(VOICE_CHIPS)
                          .map((r) => baseName(r.entry.name)).join(", ")}>
                    +{n - VOICE_CHIPS} more
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="ws-wizard-refs-act">
          <div className="ws-wizard-refs-on">
            <span className="ws-mlabel">Recorded by</span>
            {/* The full picker rather than a second, smaller one: it is the
                same choice the Models step makes and it carries the tier and
                the refusal, which a two-item segmented control would drop. It
                opens BELOW the bar rather than in a portalled menu — this bar
                already sits inside a scrolling column, and the wizard's own
                modal is a containing block for anything fixed. */}
            <button type="button" className="ws-pillbtn"
                    style={{ height: 30, gap: 7, maxWidth: 330 }}
                    aria-expanded={openPick}
                    title="Which engine records every character's voice"
                    onClick={() => setOpenPick((v) => !v)}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis",
                             whiteSpace: "nowrap" }}>{engineName}</span>
              <ChevronDown size={13} style={{ flexShrink: 0, opacity: .75,
                transform: openPick ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
            </button>
          </div>
          {n > 0 && (
            <button type="button" className="ws-wizard-refs-go"
                    disabled={queuing || !!blocked}
                    title={blocked
                      ? `${engineName} cannot record on this machine`
                      : `Record a voice for each of the ${n} without one`}
                    onClick={onGenerate}>
              {queuing ? <Loader2 size={13} className="ns-spin" /> : <Mic size={13} />}
              Record {n} voice{n === 1 ? "" : "s"}
            </button>
          )}
        </div>
      </div>
      {openPick && (
        <div style={{ marginTop: 10, padding: "14px 15px", borderRadius: 16,
                      border: "1px solid rgba(255,255,255,.07)",
                      background: "rgba(255,255,255,.02)" }}>
          <WizardModelPicker label="Voice engine" offers={offers} value={engine}
                             onPick={(id) => { onPick(id); setOpenPick(false); }}
                             onFix={onFix} admin={admin} blurbs={blurbs} />
          {/* Said here rather than only on the Models step, because this is
              where it is spent: the same pick records these clips AND casts
              every line of dialogue, so changing it later re-records both. */}
          <div style={{ marginTop: 10, fontSize: 11.5, lineHeight: 1.5, color: "#5e6678" }}>
            This is the same choice as the Models step's Dialogue voice — one engine
            records the whole cast, so every take is compared against a baseline that
            means the same thing.
          </div>
        </div>
      )}
    </div>
  );
}

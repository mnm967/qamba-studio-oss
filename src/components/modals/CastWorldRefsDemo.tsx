// The wizard's sheets bar, in every state it has, for /ui/castworld.
//
// The real one is behind a sign-in, a project, an interview and a
// several-minute plan — the same wall `/ui/replan` names for the same modal —
// and its states are minutes apart once you are there: you cannot see "nothing
// missing" and "twelve missing" on one screen, and "drawing" only exists for
// as long as the render takes. Every one of them is a claim only a picture can
// check:
//
//   * the OVERFLOW. Twelve names is the case this bar exists for, and a chip
//     row that wraps to five lines is the paragraph it replaces in a new
//     costume. `?refs=` sets the count.
//   * the PICKER beside the button. Both are on the right, and the picker's
//     own trigger is width:100% — so a width set on the wrong element is a
//     control that either collapses or shoves the button off the row.
//   * the three states reading DIFFERENTLY. Amber for the one you can act on,
//     neutral for the one that is already working, quiet for done — an amber
//     bar that is amber in all three is wallpaper by the second episode.
//
// It cannot queue anything: `onGenerate` counts presses here. A review screen
// that spends GPU time by being opened is the bar every screen in this harness
// has to clear.
import React, { useState } from "react";
import CastWorldRefsBar, { type RefEntry } from "./CastWorldRefsBar";
import RedrawSheetsDialog from "./RedrawSheetsDialog";
import CastWorldVoiceBar from "./CastWorldVoiceBar";
import PlanAutoCard from "./PlanAutoCard";
import { primeCatalog } from "../../lib/catalog";
import { toggleAuto, type AutoKey } from "../../lib/planAuto";
import { pickOf, VOICE_BLURBS, VOICE_CHOICES, type WizardOffer } from "../../lib/wizardModels";
import type { SpeakingRole } from "../../lib/voiceRefs";
import type { BibleEntry, ModelCatalogRow } from "../../lib/db/types";

// Real names from a real board — the ones in the report this bar was rewritten
// from — because the thing being looked at is how a dozen of them behave in a
// fixed width, and "Entry 1 … Entry 12" is uniformly short in a way no
// storyboard is.
const NAMES: RefEntry[] = [
  { id: "e1", name: "Command Deck", kind: "environment" },
  { id: "e2", name: "Exterior Docking Ring", kind: "environment" },
  { id: "e3", name: "Maintenance Spine", kind: "environment" },
  { id: "e4", name: "Mechazoid Core Chamber", kind: "environment" },
  { id: "e5", name: "Observation Gallery", kind: "environment" },
  { id: "e6", name: "Salvage Bay", kind: "environment" },
  { id: "p1", name: "Lucy's Salvage Pilot Helmet", kind: "prop" },
  { id: "p2", name: "Mara's Salvage Tag", kind: "prop" },
  { id: "p3", name: "Mecha Core", kind: "prop" },
  { id: "p4", name: "Mechazoid", kind: "prop" },
  { id: "p5", name: "Shield Array Override Key", kind: "prop" },
  { id: "p6", name: "Station Emergency Beacon", kind: "prop" },
];

// One pod row and one hosted row, because the tier GROUPING inside the picker
// is part of what is being looked at — shut, the studio's GPT Image 2 and the
// same row on your own key are the same six words and a different bill.
const MODELS = [
  { id: "krea2-local", family: "krea2", display_name: "Krea 2", kind: "image",
    provider: "local", modes: ["t2i", "r2i"], enabled: true,
    capabilities: { multiRef: 4, vramGb: 24 }, sizes: [], pricing: {}, sort: 1 },
  { id: "h3-image-turbo-local", family: "minimax-h3", display_name: "MiniMax H3 · Turbo (stills)",
    kind: "image", provider: "local", modes: ["t2i", "r2i", "edit"], enabled: true,
    capabilities: { multiRef: 9 }, sizes: [], pricing: {}, sort: 2 },
  { id: "gpt-image-2", family: "gpt-image", display_name: "GPT Image 2",
    kind: "image", provider: "openai", modes: ["t2i", "edit"], enabled: true,
    capabilities: { multiRef: 8 }, sizes: [], pricing: {}, sort: 9 },
] as unknown as ModelCatalogRow[];

primeCatalog(MODELS);

/* ── the voices half ─────────────────────────────────────────────────────── */

const role = (name: string, have = false): SpeakingRole => ({
  entry: { id: name, project_id: "p", kind: "character", name, summary: null,
           doc: {}, identity_line: null, voice_ref_asset_id: have ? "a" : null,
           status: "draft", version: 1, created_at: "", updated_at: "" } as BibleEntry,
  line: "We're not leaving without it.", descriptor: "low and level", have,
});

// The cast off the same board, including the long name — a chip row that wraps
// is this bar's failure exactly as it is the sheets bar's.
const CAST = ["Mara Voss", "Kai Renn", "Juno Vale", "Captain Rhea Dorne",
              "Dr. Sato Ibarra", "Lucy Voss", "The Reclaimer"];

/** Both engines, offered on the studio's tier — the shape `voiceOffers` returns
 *  for an account with no local speech service and no key of its own, which is
 *  the machine this whole flow was reported from. */
const VOICE_OFFERS: WizardOffer[] = VOICE_CHOICES.map((c) => ({
  ...c, tier: "cloud", pick: pickOf(c.id, "cloud"), blocked: null,
}));

function VoiceCase({ title, why, pending, drawing, done, blocked }: {
  title: string; why: string; pending: SpeakingRole[];
  drawing: number; done: number; blocked?: string;
}) {
  const [engine, setEngine] = useState(VOICE_OFFERS[0].pick);
  const [queuing, setQueuing] = useState(false);
  const [presses, setPresses] = useState(0);
  const picked = VOICE_OFFERS.find((o) => o.pick === engine);
  return (
    <section data-case="voices" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span className="mono" style={{ fontSize: 11, letterSpacing: ".08em",
                                        textTransform: "uppercase", color: "#5aa2ff" }}>
          {title}
        </span>
        <span style={{ fontSize: 11.5, color: "#5e6678" }}>{why}</span>
        {presses > 0 && (
          <span className="mono" data-vpresses={presses}
                style={{ fontSize: 11, color: "#6fd08c" }}>
            record pressed x{presses}
          </span>
        )}
      </div>
      <CastWorldVoiceBar
        pending={pending} drawing={drawing} done={done}
        engine={engine} engineName={picked?.name ?? engine}
        blocked={blocked ?? null}
        offers={VOICE_OFFERS} onPick={setEngine} onFix={() => { /* no engine window here */ }}
        admin blurbs={VOICE_BLURBS}
        queuing={queuing}
        onGenerate={() => {
          setPresses((n) => n + 1);
          setQueuing(true);
          setTimeout(() => setQueuing(false), 1400);
        }}
        onOpen={() => { /* the entry modal is a different screen */ }} />
    </section>
  );
}

function AutoCase() {
  const [on, setOn] = useState<Set<AutoKey>>(() => new Set());
  const [tier, setTier] = useState<1 | 2>(2);
  return (
    <section data-case="auto" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span className="mono" style={{ fontSize: 11, letterSpacing: ".08em",
                                        textTransform: "uppercase", color: "#5aa2ff" }}>
          what the plan draws
        </span>
        <span style={{ fontSize: 11.5, color: "#5e6678" }}>
          step 1's aside — panels are refused until sheets are on, and full auto
          overrides all three
        </span>
        <button className="ws-microbtn" onClick={() => setTier((t) => (t === 1 ? 2 : 1))}>
          tier {tier}
        </button>
      </div>
      {/* The real one is 288px wide, which is the whole reason its copy is
          three lines and not a paragraph. */}
      <div style={{ width: 288 }}>
        <PlanAutoCard on={on} tier={tier}
                      onToggle={(k) => setOn((cur) => toggleAuto(cur, k))} />
      </div>
    </section>
  );
}

const q = () => new URLSearchParams(window.location.search);

function Case({ title, why, pending, drawing }: {
  title: string; why: string; pending: RefEntry[]; drawing: number;
}) {
  const [model, setModel] = useState("krea2-local");
  const [queuing, setQueuing] = useState(false);
  const [presses, setPresses] = useState(0);
  const [redraws, setRedraws] = useState(0);
  const [ask, setAsk] = useState(false);
  return (
    <section data-case="sheets" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span className="mono" style={{ fontSize: 11, letterSpacing: ".08em",
                                        textTransform: "uppercase", color: "#5aa2ff" }}>
          {title}
        </span>
        <span style={{ fontSize: 11.5, color: "#5e6678" }}>{why}</span>
        {presses > 0 && (
          <span className="mono" data-presses={presses}
                style={{ fontSize: 11, color: "#6fd08c" }}>
            generate pressed ×{presses}
          </span>
        )}
        {redraws > 0 && (
          <span className="mono" data-redraws={redraws}
                style={{ fontSize: 11, color: "#ffb454" }}>
            redraw pressed ×{redraws}
          </span>
        )}
      </div>
      <CastWorldRefsBar
        pending={pending} drawing={drawing}
        models={MODELS} model={model} onModel={setModel}
        queuing={queuing}
        // REDRAW ALL is on screen in every state, including the calm one —
        // which is the state it matters most in and the one hardest to reach
        // in the real wizard, since it needs a bible that is already fully
        // drawn. The confirmation behind it is `RedrawSheetsDialog`; this
        // harness stops at the press, because a review screen that could
        // spend a render by being opened is what /ui/blockaudio's no-queue
        // rule already forbids.
        redrawable={NAMES.length}
        onRedrawAll={() => setAsk(true)}
        // The busy flag is what stops a second press queueing a second sheet
        // per entry. Held for a beat so the spinner and the disabled state are
        // both visible in a screenshot.
        onGenerate={() => {
          setPresses((n) => n + 1);
          setQueuing(true);
          setTimeout(() => setQueuing(false), 1400);
        }}
        onOpen={(id) => setPresses((n) => n)} />
      {/* The half of the gesture nobody can otherwise look at: the button is
          one press away and the dialog behind it is behind a session, a
          project and a finished plan. It counts the confirm rather than
          running it — a review screen that could spend a render by being
          opened is what /ui/blockaudio's no-queue rule already forbids. */}
      {ask && (
        <RedrawSheetsDialog
          characters={NAMES.filter((e) => e.kind === "character").length}
          environments={NAMES.filter((e) => e.kind === "environment").length}
          props={NAMES.filter((e) => e.kind === "prop").length}
          busy={false}
          onCancel={() => setAsk(false)}
          onConfirm={() => { setAsk(false); setRedraws((n) => n + 1); }} />
      )}
    </section>
  );
}

export default function CastWorldRefsDemo() {
  const refs = Math.max(0, Math.min(NAMES.length, Number(q().get("refs") ?? 12)));
  const pending = NAMES.slice(0, refs);
  return (
    <div className="ns-scroll"
         style={{ height: "100vh", overflowY: "auto", padding: "26px 30px",
                  display: "flex", flexDirection: "column", gap: 26,
                  // The step's own column width, so the wrap points here are
                  // the wrap points there.
                  maxWidth: 1040, margin: "0 auto" }}>
      {/* `.ws-card` is also the harness's mount signal — `open()` in
          scripts/ui-test.mjs waits for one of four shells before it asserts
          anything, and this screen is otherwise a bare scroll column. */}
      <div className="ws-card" style={{ fontSize: 13, color: "#8b93a7", lineHeight: 1.6 }}>
        The two bars at the top of the wizard's <b>cast &amp; world</b> step, and the
        card on <b>step 1</b> that decides whether either has anything to do.
        <span className="mono" style={{ color: "#5e6678" }}> ?refs=0…{NAMES.length}</span> sets
        how many sheets are missing.
      </div>
      <Case title="something missing" pending={pending}
            why="amber, names as chips, the button counts what it would draw" drawing={0} />
      <Case title="missing + drawing" pending={pending.slice(0, 3)}
            why="the ones in flight are counted, never re-queued" drawing={4} />
      <Case title="drawing only" pending={[]}
            why="not a warning — the button worked, and the cards fill in" drawing={5} />
      <Case title="nothing to do" pending={[]}
            why="the bar stays: the per-card re-rolls spend the same pick" drawing={0} />
      <Case title="one" pending={[NAMES[8]]}
            why="singulars, and one chip must not read as a list" drawing={0} />

      {/* The voices bar is the sheets bar's twin and has to READ as one — same
          box, same chips, same button shape — while its states are its own. */}
      <VoiceCase title="voices missing" why="the whole cast, none recorded"
                 pending={CAST.map((n) => role(n))} drawing={0} done={0} />
      <VoiceCase title="voices missing + recording"
                 why="in flight is counted, never re-queued"
                 pending={CAST.slice(0, 2).map((n) => role(n))} drawing={3} done={2} />
      <VoiceCase title="every voice recorded"
                 why="quiet, and the picker stays — it still casts the dialogue"
                 pending={[]} drawing={0} done={CAST.length} />
      <VoiceCase title="the engine cannot record here"
                 why="red, the button refuses, and the reason is the picker's own"
                 pending={CAST.slice(0, 4).map((n) => role(n))} drawing={0} done={0}
                 blocked="Breeze is not installed on this computer" />
      <VoiceCase title="nobody speaks"
                 why="renders NOTHING — a bar about recording a silent film is noise"
                 pending={[]} drawing={0} done={0} />

      <AutoCase />
    </div>
  );
}

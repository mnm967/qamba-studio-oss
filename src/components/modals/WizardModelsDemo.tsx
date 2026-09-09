// The one-shot wizard's model pickers, on four machines at once, for
// /ui/wizmodels.
//
// The real screen is behind a sign-in, a project, an interview and a
// several-minute plan — the wall `/ui/replan` names for the same modal — and
// what it shows depends on a MACHINE this repo is not: a member's laptop with
// half the weights down, an admin's box with everything, a project that lives
// on the disk it is running on. Every one of those is a claim only a picture
// can check:
//
//   * THE SECTIONS ARE THE ANSWER. "On this machine" and "Studio cloud" have
//     to read as two places, in one glance, or the rework bought nothing over
//     the five identical rows it replaces.
//   * EVERY MODEL BOTH PLANES CAN RUN IS ON BOTH, so "where" is a decision
//     rather than something the machine settled for you — and the two cards of
//     one model must not both light up.
//   * THE LOCAL SECTION IS NEVER EMPTY, and it is on top. A desktop app whose
//     pitch is your own hardware, opening on nothing but the studio's, is what
//     this looked like before — so every model this build can render is listed
//     from the first launch with the download that would put it there, and the
//     section has to read as an invitation rather than a wall of refusals.
//   * THE CHIP ON THE HEADER, not on every row. "Coming soon" said five times
//     buries the one thing a row has to say, which is what the model is.
//
// It queues nothing and reads nothing: the offers are computed by the real
// `wizardModels.ts` from fixtures, which is also what lets all four machines
// sit on one page.
import React, { useState } from "react";
import WizardModelPicker from "./WizardModelPicker";
import {
  VIDEO_CHOICES, VOICE_BLURBS, VOICE_CHOICES, pickOf, videoOffers, voiceOffers,
  type WizardFacts,
} from "../../lib/wizardModels";
import type { BreezeStatus } from "../../lib/breezeLocal";
import type { QwenStatus } from "../../lib/qwenLocal";
import type { RenderableModel } from "../../lib/desktopRows";

/** Real keys off `model_map.desktop.json`, so the harness cannot suggest a
 *  local option the shipped map does not carry. */
const DOWN: RenderableModel[] = [
  { key: "minimax-h3", ready: true, missing: [] },
  { key: "minimax-h3-pdd", ready: true, missing: [] },
  { key: "ltx-25", ready: true, missing: [] },
  { key: "minimax-h3-q4", ready: true, missing: [] },
];
/** The same machine before any of it has been downloaded. */
const NOT_DOWN: RenderableModel[] = DOWN.map((m) => ({
  ...m, ready: false, missing: [`${m.key}_int8_convrot.safetensors`, "vae.safetensors"],
}));

const breeze = (p: Partial<BreezeStatus>): BreezeStatus => ({
  installed: false, code: false, venv: false, weights_mb: 0,
  weights_total_mb: 7328, weights_missing: ["model.safetensors"],
  reachable: false, ours: false, starting: false, foreign: false,
  device: "mps", rev: "d76819fa9c04", port: 7860, root: "/mock/engine/breeze",
  license: "BreezeBlue Research — non-commercial", ...p,
});

const qwen = (p: Partial<QwenStatus>): QwenStatus => ({
  installed: false, venv: false, weights_mb: 0,
  weights_total_mb: 8871, weights_missing: ["model.safetensors"],
  reachable: false, ours: false, starting: false, foreign: false,
  device: "mps", port: 7870, root: "/mock/engine/qwen",
  license: "Apache 2.0", supports_direction: false, ...p,
});

/** Every pack the shipped rows name (`WizardChoice.packs`), installed. */
const PACKS = ["ComfyUI-GGUF", "ComfyUI-LTX2.5-MSR", "ComfyUI-MiniMax-H3-PDD-Acc"];

const DESKTOP: WizardFacts = {
  desktop: true, models: DOWN, planner: true, ffmpeg: true, nodes: PACKS,
  admin: false, localProject: false, speechKeys: [],
  breeze: breeze({ installed: true, reachable: true }),
  qwen: qwen({ installed: true, reachable: true }),
};

const CASES: { title: string; why: string; facts: WizardFacts }[] = [
  {
    title: "member · everything downloaded",
    why: "the standalone product: four models render here, Turbo is refused "
      + "with the reason, and every one of them is on the studio's too",
    facts: DESKTOP,
  },
  {
    title: "member · nothing downloaded yet",
    why: "a fresh install: every local card carries its own download, the "
      + "studio's copies of the same models are below, and the voice planes split",
    facts: { ...DESKTOP, models: NOT_DOWN, breeze: breeze({}), qwen: qwen({}) },
  },
  {
    title: "member · engine Python never installed",
    why: "weights on disk, no runner — one fact about the machine, said once "
      + "on the heading rather than on all seven rows",
    facts: { ...DESKTOP, planner: false, breeze: breeze({ installed: true }),
             qwen: qwen({ installed: true }) },
  },
  {
    title: "admin · the studio's own machine",
    why: "nothing is blocked — the pod renders every row, so the sections say "
      + "WHERE rather than refusing anything",
    facts: { ...DESKTOP, admin: true, breeze: breeze({ installed: true }) },
  },
  {
    title: "one local engine up, the other not installed",
    why: "the two engines install, start and fail separately — each card has "
      + "to report ITS OWN service, which one shared status could not do",
    facts: { ...DESKTOP, breeze: breeze({ installed: true, reachable: true }),
             qwen: qwen({}) },
  },
  {
    title: "Apache-only: Qwen serving, Breeze never installed",
    why: "the licence choice made concrete — Breeze's weights are "
      + "non-commercial, so this is the machine that deliberately has only the "
      + "Apache engine",
    facts: { ...DESKTOP, breeze: breeze({}),
             qwen: qwen({ installed: true, reachable: true }) },
  },
  {
    title: "member · a key of your own",
    why: "the key is pasted, so ElevenLabs stops offering itself and simply "
      + "works — on this machine, on your bill",
    facts: { ...DESKTOP, speechKeys: ["elevenlabs"] },
  },
  {
    title: "weights down, node packs missing",
    why: "the loader is not the weights: a GGUF rung with no ComfyUI-GGUF "
      + "reads as ready off the model map and dies inside ComfyUI",
    facts: { ...DESKTOP, admin: true, nodes: [] },
  },
  {
    title: "project on this computer",
    why: "the pod cannot see these rows at all, so the studio's cards are "
      + "refused to an ADMIN too — while the local ones keep their own "
      + "download, which is the section that can do anything about it",
    facts: { ...DESKTOP, admin: true, localProject: true },
  },
  {
    title: "the web build",
    why: "no local plane exists, so there are no sections to draw — one list, "
      + "exactly as it was before this",
    facts: { desktop: false, models: null, planner: false, ffmpeg: false,
             admin: false, localProject: false, speechKeys: [], nodes: null },
  },
];

function Case({ title, why, facts }: { title: string; why: string; facts: WizardFacts }) {
  const [video, setVideo] = useState(pickOf("h3-turbo-local", "cloud"));
  const [voice, setVoice] = useState(pickOf("breeze", "cloud"));
  const [fixes, setFixes] = useState<string[]>([]);
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span className="mono" style={{ fontSize: 11, letterSpacing: ".08em",
                                        textTransform: "uppercase", color: "#5aa2ff" }}>
          {title}
        </span>
        <span style={{ fontSize: 11.5, color: "#5e6678", flex: 1, minWidth: 160 }}>{why}</span>
        {fixes.length > 0 && (
          <span className="mono" data-fixes={fixes.join(",")}
                style={{ fontSize: 11, color: "#6fd08c" }}>
            fix → {fixes.join(", ")}
          </span>
        )}
      </div>
      {/* The wizard's own step-4 column width, because the thing being looked
          at is how a 14px name, an amber chip and a three-line blurb behave
          together in it. */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, alignItems: "start" }}>
        <WizardModelPicker
          label="Video model" offers={videoOffers(VIDEO_CHOICES, facts)}
          value={video} onPick={setVideo} admin={facts.admin}
          onFix={(tab) => setFixes((f) => [...f, tab])} />
        <WizardModelPicker
          label="Dialogue voice" offers={voiceOffers(VOICE_CHOICES, facts)}
          value={voice} onPick={setVoice} admin={facts.admin} blurbs={VOICE_BLURBS}
          onFix={(tab) => setFixes((f) => [...f, tab])} />
      </div>
    </section>
  );
}

export default function WizardModelsDemo() {
  const only = new URLSearchParams(window.location.search).get("case");
  const cases = only ? CASES.filter((c) => c.title.includes(only)) : CASES;
  return (
    <div className="ns-scroll"
         style={{ height: "100vh", overflowY: "auto", padding: "26px 30px",
                  display: "flex", flexDirection: "column", gap: 34 }}>
      {/* `.ws-card` is also the harness's mount signal — `open()` in
          scripts/ui-test.mjs waits for one of four shells before it asserts
          anything, and this screen is otherwise a bare scroll column. */}
      <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-.015em" }}>
          Wizard step 4 — where each pick runs
        </div>
        <div style={{ fontSize: 12, color: "#5e6678", lineHeight: 1.6, maxWidth: 760 }}>
          Seven machines, one component. <span className="mono">?case=admin</span> narrows
          it to one. Nothing here queues, downloads or signs in — the tiers are
          computed by the shipped <span className="mono">wizardModels.ts</span> from
          fixtures, and the fix buttons count presses instead of opening the
          engine window.
        </div>
      </div>
      {cases.map((c) => <Case key={c.title} {...c} />)}
    </div>
  );
}

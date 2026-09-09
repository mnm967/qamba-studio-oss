// The one-shot wizard's two pickers, tiered.
//
// Every case here is a machine this repo cannot be asked to produce on demand
// — a member on a laptop with half the weights down, an admin whose engine
// Python was never installed, a project that lives on the disk the picker is
// running on — and each of them used to render as five rows all claiming to be
// the studio's.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VIDEO_CHOICES, VOICE_CHOICES, defaultChoice, localReason, localVoiceReason,
  packReason, parsePick, pickOf, pickedOffer, videoOffers, voiceOffers,
  type WizardFacts, type WizardOffer,
} from "./wizardModels.ts";
import type { BreezeStatus } from "./breezeLocal.ts";
import type { QwenStatus } from "./qwenLocal.ts";
import { LOCAL_ENGINES } from "./speechProviders.ts";
import type { RenderableModel } from "./desktopRows.ts";

/** Every video key the shipped desktop map carries, downloaded. */
const READY: RenderableModel[] = [
  { key: "minimax-h3", ready: true, missing: [] },
  { key: "minimax-h3-pdd", ready: true, missing: [] },
  { key: "ltx-25", ready: true, missing: [] },
  { key: "minimax-h3-q4", ready: true, missing: [] },
];

/** Every pack the shipped rows name, installed — see `WizardChoice.packs`. */
const PACKS = ["ComfyUI-GGUF", "ComfyUI-LTX2.5-MSR", "ComfyUI-MiniMax-H3-PDD-Acc"];

const WEB: WizardFacts = {
  desktop: false, models: null, planner: false, ffmpeg: false,
  admin: true, localProject: false, speechKeys: [], nodes: null,
};
const DESKTOP: WizardFacts = {
  ...WEB, desktop: true, models: READY, planner: true, ffmpeg: true, nodes: PACKS,
};

/** A card is a model AND a plane, so every lookup names both. */
const cardOf = (rows: WizardOffer[], id: string, tier = "local") =>
  rows.find((r) => r.id === id && r.tier === tier);
const blockOf = (rows: WizardOffer[], id: string, tier = "local") =>
  cardOf(rows, id, tier)?.blocked;
const planes = (rows: WizardOffer[], id: string) =>
  rows.filter((r) => r.id === id).map((r) => r.tier).sort();

/* ── video ──────────────────────────────────────────────────────────────── */

test("on the web there is only the studio's, and no rung is offered", () => {
  const rows = videoOffers(VIDEO_CHOICES, WEB);
  assert.ok(rows.every((r) => r.tier === "cloud"));
  // The quantised rungs exist in the DESKTOP map alone. Offering one in a
  // browser is an episode whose every block dies on `model 'minimax-h3-q4'
  // not available on tier 'aws'`.
  assert.equal(rows.filter((r) => r.rung).length, 0);
});

test("EVERY MODEL BOTH PLANES CAN RUN IS ON BOTH, and the pick carries which", () => {
  // "Which model" and "where" are two decisions, and the wizard was only
  // letting you make the first: an admin whose laptop held the weights had no
  // way to say "render this in the studio".
  const rows = videoOffers(VIDEO_CHOICES, DESKTOP);
  for (const id of ["h3-local", "h3-pdd-local", "ltx-25-local"]) {
    assert.deepEqual(planes(rows, id), ["cloud", "local"], id);
  }
  // Turbo gets a local card that REFUSES rather than no card at all — its
  // absence from the section was a mystery, and this build can never render it
  // here whatever is downloaded.
  assert.deepEqual(planes(rows, "h3-turbo-local"), ["cloud", "local"]);
  // …and it says WHY rather than shrugging: what is missing is a node pack the
  // installer does not add, which is not a download anybody can go and get.
  assert.match(blockOf(rows, "h3-turbo-local")!.why, /node pack/);
  assert.equal(blockOf(rows, "h3-turbo-local")!.fix, undefined);
  assert.equal(blockOf(rows, "h3-turbo-local", "cloud"), null);
  // The hosted row is an API by construction, and a rung has no pod under it.
  assert.deepEqual(planes(rows, "h3-api"), ["cloud"]);
  assert.deepEqual(planes(rows, "h3-q4-local"), ["local"]);
  // The value is a model AND a plane, and it round-trips.
  const one = cardOf(rows, "h3-local")!;
  assert.equal(one.pick, pickOf("h3-local", "local"));
  assert.deepEqual(parsePick(one.pick), { id: "h3-local", tier: "local" });
  // A pick made before any of this existed reads as the studio's, which is
  // where every one of them went.
  assert.deepEqual(parsePick("h3-local"), { id: "h3-local", tier: "cloud" });
});

test("a desktop that has the weights renders them HERE", () => {
  const rows = videoOffers(VIDEO_CHOICES, DESKTOP);
  for (const id of ["h3-local", "h3-pdd-local", "ltx-25-local"]) {
    assert.equal(blockOf(rows, id), null, id);
  }
});

test("A CARD IS REFUSED BY ITS OWN PLANE, which is what a local project broke", () => {
  // The pod cannot see a project that lives on this disk — so the CLOUD cards
  // are refused, and the local ones must not be: they were, with a sentence
  // about the studio, which took the download button off the one section that
  // could do anything about it.
  const half = [{ key: "minimax-h3", ready: false, missing: ["a.safetensors"] }];
  const rows = videoOffers(VIDEO_CHOICES,
    { ...DESKTOP, models: half, localProject: true });
  assert.match(blockOf(rows, "h3-local", "cloud")!.why, /cannot see its rows/);
  const local = blockOf(rows, "h3-local")!;
  assert.equal(local.fix, "models");
  assert.match(local.why, /a\.safetensors/);
});

test("a member is refused the studio's, in its words, and keeps this machine's", () => {
  const rows = videoOffers(VIDEO_CHOICES, { ...DESKTOP, admin: false });
  // NOTHING IS HIDDEN — the row is listed, and says why.
  assert.match(blockOf(rows, "h3-turbo-local", "cloud")!.why, /coming soon/);
  assert.match(blockOf(rows, "h3-api", "cloud")!.why, /coming soon/);
  // …while every model this machine holds is pickable, on the local tier.
  assert.equal(blockOf(rows, "h3-pdd-local"), null);
});

test("an un-downloaded model is a DOWNLOAD here and unaffected there", () => {
  const none: RenderableModel[] = [
    { key: "minimax-h3", ready: false, missing: ["a.safetensors", "b"] },
  ];
  const rows = videoOffers(VIDEO_CHOICES, { ...DESKTOP, models: none });
  const local = blockOf(rows, "h3-local")!;
  assert.equal(local.fix, "models");
  assert.match(local.why, /a\.safetensors/);
  // The weights are the big commitment, so an admin who wants the pod keeps
  // the pod — on the card that says so.
  assert.equal(blockOf(rows, "h3-local", "cloud"), null);
});

test("the local section is never empty on a desktop", () => {
  // What the picker looked like on a fresh install before this: no local
  // section at all, and the studio's cloud on top of a build whose whole pitch
  // is your own hardware.
  const nothing = READY.map((m) => ({ ...m, ready: false, missing: ["a.safetensors"] }));
  for (const f of [DESKTOP, { ...DESKTOP, models: nothing },
                   { ...DESKTOP, models: nothing, admin: false },
                   { ...DESKTOP, localProject: true },
                   { ...DESKTOP, planner: false }, { ...DESKTOP, ffmpeg: false }]) {
    assert.ok(videoOffers(VIDEO_CHOICES, f).some((r) => r.tier === "local"),
              JSON.stringify({ ...f, models: !!f.models }));
    assert.ok(voiceOffers(VOICE_CHOICES, f).some((r) => r.tier !== "cloud"));
  }
  // …and on the web there is no local plane to draw, so there is none.
  assert.ok(!videoOffers(VIDEO_CHOICES, WEB).some((r) => r.tier === "local"));
});

test("a quantised rung is offered only once its weights are down", () => {
  const rows = videoOffers(VIDEO_CHOICES, DESKTOP);
  assert.equal(blockOf(rows, "h3-q4-local"), null);
  // The other two are in the map and NOT downloaded here, and a wall of
  // "download 20GB" under a model already on screen is what this filter is
  // for — the rung is chosen in the engine window, not here.
  assert.ok(!rows.some((r) => r.id === "h3-q5-local"));
});

test("WEIGHTS ON DISK IS NOT AVAILABILITY — the loader has to be there too", () => {
  // A rung with its 20GB down and no `ComfyUI-GGUF` reads as ready off the
  // model map and dies inside ComfyUI on a missing `UnetLoaderGGUF`, after the
  // block is claimed. Same for PDD's accelerator and LTX's reference nodes.
  const bare = { ...DESKTOP, nodes: [] as string[] };
  assert.match(blockOf(videoOffers(VIDEO_CHOICES, bare), "h3-q4-local")!.why,
               /ComfyUI-GGUF/);
  assert.match(blockOf(videoOffers(VIDEO_CHOICES, bare), "h3-pdd-local")!.why,
               /PDD-Acc/);
  assert.match(blockOf(videoOffers(VIDEO_CHOICES, bare), "ltx-25-local")!.why,
               /MSR/);
  // Plain H3 is core nodes only and is unaffected.
  assert.equal(blockOf(videoOffers(VIDEO_CHOICES, bare), "h3-local"), null);
  // A pack whose dependencies were REFUSED looks identical to one never
  // installed, and has a different fix — `markFor`'s own rule.
  const broke = { ...DESKTOP, nodes: [], nodesBroken: ["ComfyUI-GGUF"] };
  assert.match(blockOf(videoOffers(VIDEO_CHOICES, broke), "h3-q4-local")!.why,
               /would not install/);
  // Nobody has asked yet is not "absent": a status that has not landed must
  // not refuse a row this machine can run.
  assert.equal(packReason(VIDEO_CHOICES.find((c) => c.id === "h3-q4-local")!,
                          { ...DESKTOP, nodes: null }), null);
});

test("the ladder is renderableHere's, deepest prerequisite first", () => {
  const c = VIDEO_CHOICES.find((v) => v.id === "h3-local")!;
  assert.match(localReason(c, { ...DESKTOP, planner: false })!.why, /Python is not installed/);
  assert.match(localReason(c, { ...DESKTOP, ffmpeg: false })!.why, /ffmpeg/);
  assert.equal(localReason(c, DESKTOP), null);
  // Nobody has answered yet: no sentence, so nothing flashes for the length of
  // one poll.
  assert.equal(localReason(c, { ...DESKTOP, models: null })!.why, "");
});

test("a machine-wide shortfall is ONE fact, marked for the heading", () => {
  // Five rows each printing "the local engine's Python is not installed" is
  // the wall this rework exists to avoid — so the ladder's machine-wide rungs
  // are `tier`-marked and the picker says them once per section.
  const rows = videoOffers(VIDEO_CHOICES, { ...DESKTOP, planner: false })
    .filter((r) => r.tier === "local");
  assert.ok(rows.length > 1);
  assert.ok(rows.every((r) => r.blocked!.tier));
  // …while a DOWNLOAD is the row's own and stays on it.
  const one = [{ key: "minimax-h3", ready: false, missing: ["a.safetensors"] }];
  const down = videoOffers(VIDEO_CHOICES, { ...DESKTOP, models: one });
  assert.equal(blockOf(down, "h3-local")!.tier, undefined);
});

/* ── voice ──────────────────────────────────────────────────────────────── */

const breeze = (p: Partial<BreezeStatus>): BreezeStatus => ({
  installed: false, code: false, venv: false, weights_mb: 0,
  weights_total_mb: 7328, weights_missing: ["model.safetensors"],
  reachable: false, ours: false, starting: false, foreign: false,
  device: null, rev: "", port: 7860, root: "/e/breeze", license: "", ...p,
});

test("both engines are on both planes, and the plane is whose account", () => {
  // It decides where the `tts` jobs are claimed: this machine's own Breeze and
  // a key of your own are `planLanes`' `speech`; the studio's cloud is its own
  // queue on its own bill.
  const rows = voiceOffers(VOICE_CHOICES,
    { ...DESKTOP, breeze: breeze({ installed: true, reachable: true }) });
  assert.deepEqual(planes(rows, "breeze"), ["cloud", "local"]);
  assert.deepEqual(planes(rows, "elevenlabs"), ["byok", "cloud"]);
});

test("Breeze serving here is recorded here", () => {
  const rows = voiceOffers(VOICE_CHOICES,
    { ...DESKTOP, breeze: breeze({ installed: true, reachable: true }) });
  assert.equal(blockOf(rows, "breeze"), null);
});

test("Breeze installed and asleep says which tab, on its own card", () => {
  const rows = voiceOffers(VOICE_CHOICES,
    { ...DESKTOP, admin: false, breeze: breeze({ installed: true }) });
  const b = blockOf(rows, "breeze")!;
  assert.equal(b.fix, "speech");
  assert.match(b.why, /start Breeze/);
  // The studio runs it too, and that card is refused for the account rather
  // than for anything about this machine.
  assert.match(blockOf(rows, "breeze", "cloud")!.why, /coming soon/);
});

test("Breeze never installed offers the install, and the studio still records", () => {
  const rows = voiceOffers(VOICE_CHOICES, { ...DESKTOP, breeze: breeze({}) });
  assert.equal(blockOf(rows, "breeze")!.fix, "speech");
  assert.equal(blockOf(rows, "breeze", "cloud"), null);
});

const qwen = (p: Partial<QwenStatus>): QwenStatus => ({
  installed: false, venv: false, weights_mb: 0,
  weights_total_mb: 8871, weights_missing: ["model.safetensors"],
  reachable: false, ours: false, starting: false, foreign: false,
  device: null, port: 7870, root: "/e/qwen", license: "",
  supports_direction: false, ...p,
});

test("every local speech engine has a card of its own", () => {
  // The wizard is where an episode is CAST, and a cast is not re-castable
  // without a re-plan — so an engine the worker will happily accept
  // (`resolve_provider` takes anything in `ENGINES`) and the picker cannot
  // name is an engine nobody can choose. `LOCAL_ENGINES` is the browser's copy
  // of the worker's own table, so this is the pin that keeps the two in step.
  for (const e of LOCAL_ENGINES) {
    assert.ok(VOICE_CHOICES.some((c) => c.id === e && c.local),
      `${e} has no VOICE_CHOICES row — the wizard cannot cast on it`);
  }
});

test("each local engine reports ITS OWN service, not the other's", () => {
  // THE BUG THIS PINS: `localVoiceReason` read `breezeBlocked(f.breeze)` for
  // every local row, so with Breeze up and Qwen absent the Qwen card came back
  // unblocked — offering an engine that is not on the machine — and with the
  // pair reversed it refused one that was fine. Both are plausible sentences
  // about a speech engine, so neither reads as wrong.
  const rows = voiceOffers(VOICE_CHOICES, {
    ...DESKTOP,
    breeze: breeze({ installed: true, reachable: true }),
    qwen: qwen({}),
  });
  assert.equal(blockOf(rows, "breeze"), null, "Breeze is serving and must not be blocked");
  const q = blockOf(rows, "qwen");
  assert.ok(q, "Qwen is not installed here and must be blocked");
  assert.match(q!.why, /Qwen/, "the refusal must name the engine it is about");
  assert.equal(q!.fix, "speech");
});

test("...and the other way round, which a shared status would also pass", () => {
  const rows = voiceOffers(VOICE_CHOICES, {
    ...DESKTOP,
    breeze: breeze({}),
    qwen: qwen({ installed: true, reachable: true }),
  });
  assert.equal(blockOf(rows, "qwen"), null);
  assert.match(blockOf(rows, "breeze")!.why, /Breeze/);
});

test("an engine this build has not asked about blocks with no sentence", () => {
  // `undefined` is "nobody has asked" and must not read as "not installed" —
  // marking a row absent from an answer nobody sought is how a picker tells a
  // machine it lacks an engine it is running.
  const rows = voiceOffers(VOICE_CHOICES, { ...DESKTOP, breeze: breeze({}) });
  assert.equal(blockOf(rows, "qwen")!.why, "");
});

test("a key of your own is its own plane, whoever you are", () => {
  const rows = voiceOffers(VOICE_CHOICES,
    { ...DESKTOP, admin: false, speechKeys: ["elevenlabs"] });
  assert.equal(blockOf(rows, "elevenlabs", "byok"), null);
});

test("a keyless speech row still gets its section, and names the key", () => {
  // `byokOfferRows`' rule: a section that appears only once a key is pasted
  // reads as a build that cannot do hosted work at all, when it is one paste
  // away — and this row is the only place that names which key.
  const b = blockOf(voiceOffers(VOICE_CHOICES, DESKTOP), "elevenlabs", "byok")!;
  assert.equal(b.fix, "keys");
  assert.match(b.why, /ElevenLabs key/);
});

test("on the web a member gets the plain refusal — there is no keychain there", () => {
  const rows = voiceOffers(VOICE_CHOICES, { ...WEB, admin: false });
  assert.deepEqual(planes(rows, "elevenlabs"), ["cloud"]);
  assert.match(blockOf(rows, "elevenlabs", "cloud")!.why, /coming soon/);
  assert.equal(blockOf(rows, "elevenlabs", "cloud")!.fix, undefined);
});

test("recording here needs the pipeline, exactly as rendering does", () => {
  const c = VOICE_CHOICES.find((v) => v.id === "breeze")!;
  assert.match(
    localVoiceReason(c, { ...DESKTOP, planner: false,
                          breeze: breeze({ installed: true, reachable: true }) })!.why,
    /Python is not installed/);
});

/* ── the selection ──────────────────────────────────────────────────────── */

test("a blocked pick moves, and keeps its MODEL where it can", () => {
  const rows = videoOffers(VIDEO_CHOICES, { ...DESKTOP, admin: false });
  // A member's studio-cloud H3 moves to the same model on this machine rather
  // than to whatever is first — moving somebody off H3 because their account
  // cannot spend the studio's is a substitution nobody asked for.
  assert.equal(defaultChoice(rows, pickOf("h3-local", "cloud")),
               pickOf("h3-local", "local"));
  // A pickable one is left alone — this must not fight the user.
  assert.equal(defaultChoice(rows, pickOf("ltx-25-local", "local")),
               pickOf("ltx-25-local", "local"));
  // The wizard's stored default is Turbo, which a member cannot spend and this
  // build cannot render here, so it moves off the model too.
  assert.equal(defaultChoice(rows, pickOf("h3-turbo-local", "cloud")),
               pickOf("h3-pdd-local", "local"));
});

test("with nothing pickable the current value stands rather than being replaced", () => {
  // It then renders blocked, with its reason, and the queue button refuses.
  // Substituting a model nobody chose is the silent downgrade this codebase
  // keeps naming.
  const rows = videoOffers(VIDEO_CHOICES, { ...WEB, admin: false });
  const v = pickOf("h3-turbo-local", "cloud");
  assert.equal(defaultChoice(rows, v), v);
});

test("pickedOffer answers for the CARD asked about, or nothing", () => {
  const rows = videoOffers(VIDEO_CHOICES, DESKTOP);
  assert.equal(pickedOffer(rows, pickOf("h3-local", "local"))?.tier, "local");
  assert.equal(pickedOffer(rows, pickOf("h3-local", "cloud"))?.tier, "cloud");
  // A model with no card on that plane is not a near-miss — it is nothing.
  assert.equal(pickedOffer(rows, pickOf("h3-api", "local")), null);
  assert.equal(pickedOffer(rows, "nope"), null);
});

/* ── the rows themselves ────────────────────────────────────────────────── */

test("every video row names a model_map key, or is hosted", () => {
  // A key that is not in the map is a row that can never be local; a key that
  // is WRONG is worse, because it reads as local and dies in `resolve()`.
  // `desktopModelMap.test.ts` pins the map itself; this pins that we named
  // one at all.
  for (const c of VIDEO_CHOICES) {
    if (c.id === "h3-api") { assert.equal(c.key, undefined); continue; }
    assert.ok(c.key, `${c.id} names no key`);
  }
});

test("the studio's card never carries a sentence about this machine", () => {
  // It was doing both at once: "the local engine's Python is not installed"
  // sat under Turbo in the studio's section, naming a fix that would move
  // nothing. A card answers for its own plane and nothing else.
  const rows = videoOffers(VIDEO_CHOICES, { ...DESKTOP, planner: false, admin: false });
  for (const r of rows.filter((o) => o.tier === "cloud")) {
    assert.match(r.blocked!.why, /coming soon/, r.id);
  }
  assert.match(blockOf(rows, "h3-local")!.why, /Python is not installed/);
});

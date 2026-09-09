// WHERE THE ONE-SHOT WIZARD'S PICKS WILL ACTUALLY RUN — video and voice.
//
// The step-4 pickers were two flat lists of hand-written cards, each row
// carrying the word "studio cloud" as a literal. On the web that was true. On
// the desktop it was wrong three ways at once, and every one of them is
// silent:
//
//   * THIS MACHINE RENDERS BLOCKS. `plan_cli.KINDS` carries `master_pass`, so
//     H3, PDD and LTX 2.5 resolve against `model_map.desktop.json` and render
//     here — while the card said they were the studio's.
//   * TURBO CANNOT. Its step distillation is applied through larryvrh's node
//     pack, which the desktop installer does not add, so the generator drops
//     it from that map — and it is the wizard's DEFAULT. On a machine with no
//     pod that is an episode whose every block dies on `model
//     'minimax-h3-turbo' not available`.
//   * A MEMBER HAS NO POD AT ALL. `worker.py::_check_owner_allowed` refuses a
//     member's own project on the studio's box, so a flat list offered them
//     five rows of which the only workable ones were unlabelled.
//
// So the tier is DERIVED here, from the same facts `renderableHere` reads, and
// the sentences are ITS sentences word for word — a second phrasing of one
// refusal reads as a second rule. Pure, so every state is a test rather than a
// machine: a member on a laptop with half the weights down is not something
// this repo can be asked to produce on demand.
import type { ModelTier } from "./localModels.ts";
import { breezeBlocked, type BreezeStatus } from "./breezeLocal.ts";
import { qwenBlocked, type QwenStatus } from "./qwenLocal.ts";
import { LOCAL_ENGINES } from "./speechProviders.ts";
import type { RenderableModel } from "./desktopRows.ts";

/** Why a row cannot be picked, and where the fix lives when the user has one.
 *  Same shape and same rule as `rowBlocked`: a reason with nowhere to go is
 *  the refusal that rework exists to end. */
export interface WizardBlock {
  why: string;
  fix?: "engine" | "models" | "speech" | "keys";
  /**
   * This refusal belongs to the whole SECTION rather than to the row.
   *
   * A member is refused the studio's cloud identically on every row in it, and
   * so is a project living on this disk — so the picker says it once, on the
   * heading, and the rows go back to saying what the model is. That is
   * `TieredModelMenu`'s own rule for the same chip ("repeating it on every row
   * would bury the one thing a row has to say"), and without it the two cloud
   * rows carried the same grey sentence twice.
   */
  tier?: true;
  /** The heading's own chip, when this refusal is short enough to BE it. Set,
   *  the picker drops the sentence entirely — the chip is already saying it. */
  chip?: string;
}

/** One hand-written row, before this machine has been consulted. */
export interface WizardChoice {
  /** the catalog id the wizard stores (video) or the provider id (voice) */
  id: string;
  name: string;
  /** the amber chip — what it costs, or what it is for */
  price: string;
  blurb: string;
  /**
   * Where it runs when this machine cannot.
   *
   * `cloud` for everything the pod carries, which is nearly all of it. `local`
   * for the quantised rungs, which exist in the DESKTOP map alone — the pod
   * has a 96GB card, no reason to quantise and none of these files — so they
   * have no cloud to fall back to and must never be offered as though they
   * did.
   */
  home: ModelTier;
  /** the `model_map` key, for a row that names one */
  key?: string;
  /**
   * Why this build can never render it here, for a row the desktop map does
   * not carry. "This build cannot render it on your own machine" is true and
   * says nothing about whether that is fixable — and the one row it applies to
   * is the wizard's DEFAULT, so it is worth a sentence rather than a shrug.
   */
  whyNoLocal?: string;
  /**
   * The ComfyUI node packs a LOCAL render of this needs, by directory name —
   * `engine_status.nodes`' own spelling and `engine.rs`'s `NODE_PACKS`.
   *
   * WEIGHTS ON DISK IS NOT AVAILABILITY. `desktop_render_models` answers about
   * FILES, so a quantised rung with its 20GB down and no `ComfyUI-GGUF` reads
   * as ready and dies inside ComfyUI on a missing `UnetLoaderGGUF` — after the
   * episode is planned and the block is claimed. The same is true of PDD
   * (`MiniMaxH3PDDAccApply`) and of LTX 2.5's reference mode, which is what
   * every episode block renders on. Plain H3 needs none: core nodes only.
   */
  packs?: readonly string[];
  /** the BYOK provider whose key runs this here (voice rows) */
  provider?: string;
  /** What to CALL that key. "ElevenLabs v3" is the model; the key is the
   *  account's, and "add your ElevenLabs v3 key" names a thing nobody has. */
  keyName?: string;
  /** There is an ENGINE for this on this machine, not merely a key — Breeze
   *  is the one, and it is what separates "start it" from "add a key". */
  local?: boolean;
  /**
   * A quantised rung of a model already listed above, offered only once its
   * weights are down.
   *
   * The other rows show as downloads because each is a CAPABILITY this machine
   * does not have yet. A rung is not: H3 is already on screen, and three more
   * "download 20GB" cards under it is a wall in front of the one decision the
   * step is for. `engineCatalog`'s family/variant list is where a rung is
   * chosen; this picker only ever names one that is ready to render.
   */
  rung?: boolean;
}

/**
 * One CARD: a model and the plane it would run on.
 *
 * A MODEL THAT BOTH PLANES CAN RUN APPEARS TWICE, once per section, and the
 * pick carries both — because "which model" and "where" are two decisions and
 * the wizard was only ever letting you make the first. Deriving the second
 * from the machine is what made the sections read as a fact you could not
 * change: an admin whose laptop happens to hold the weights had no way to say
 * "render this in the studio", and on a project living on this disk the local
 * rows were refused with a sentence about the pod.
 *
 * So each card is refused by ITS OWN plane's facts: a local card by what is
 * missing on this machine (with the download that fixes it), a cloud card by
 * the account and the project. No card is listed under one heading and quietly
 * served by the other.
 */
export interface WizardOffer extends WizardChoice {
  tier: ModelTier;
  /** The radio value — `${id}@${tier}`. `id` alone cannot identify a card any
   *  more, and two cards of one model must not both light up. */
  pick: string;
  blocked: WizardBlock | null;
}

/** `${id}@${tier}` — the value a picker stores and a caller takes apart. */
export const pickOf = (id: string, tier: ModelTier): string => `${id}@${tier}`;

export function parsePick(pick: string | null | undefined):
  { id: string; tier: ModelTier } {
  const at = (pick ?? "").lastIndexOf("@");
  const tier = at > 0 ? (pick ?? "").slice(at + 1) : "";
  return {
    id: at > 0 ? (pick ?? "").slice(0, at) : (pick ?? ""),
    // An unknown suffix reads as the studio's: that is where every pick made
    // before this went, and where a row with no local form still goes.
    tier: tier === "local" || tier === "byok" ? tier : "cloud",
  };
}

/** What the decision needs to know about this machine and this account. */
export interface WizardFacts {
  /** this build has the desktop bridge — off it there is no local plane */
  desktop: boolean;
  /**
   * `desktop_render_models`, the VIDEO rows. Null is "nobody has asked yet"
   * (the web build, or before the first poll lands) and is read as no local
   * answer rather than as a refusal — marking a row "not downloaded" from an
   * absent one is how a picker tells a machine it lacks weights it has.
   */
  models: RenderableModel[] | null;
  /** the bundled pipeline's Python is on disk (`planner_ready`) */
  planner: boolean;
  /** ffmpeg AND ffprobe are reachable by a child we spawn */
  ffmpeg: boolean;
  /** `engine_status.nodes` — the packs that are installed AND usable. Null is
   *  "nobody has asked", read as no local answer rather than as none. */
  nodes?: readonly string[] | null;
  /** the ones whose dependencies were refused, which `nodes` excludes — a
   *  different fix from never having installed them (`markFor`'s rule). */
  nodesBroken?: readonly string[] | null;
  admin: boolean;
  /** this project's rows are a file on this disk, so the pod cannot see them */
  localProject: boolean;
  /** the local speech services, one field each. `undefined` = this build has
   *  not asked; `null` = asked and there is none. They are SEPARATE because
   *  they install, start and fail separately — a machine routinely has one and
   *  not the other, and the whole point of the row's refusal is naming which. */
  breeze?: BreezeStatus | null;
  qwen?: QwenStatus | null;
  /** speech providers with a key on this machine */
  speechKeys: readonly string[];
}

/** Word for word `rowBlocked`'s, because it is the same refusal — and the
 *  queue button quotes it, so it has to read as a sentence as well as a chip. */
const COMING_SOON: WizardBlock =
  { why: "runs on the studio's own account — coming soon", tier: true, chip: "coming soon" };
/** Word for word `placeOffers`', for the same reason. A fact about the
 *  PROJECT, so it refuses an admin too — and it gets a line rather than a
 *  chip, because nothing shorter says why the pod cannot see these rows. */
const NO_POD_HERE: WizardBlock = {
  why: "this project lives on this computer, and the studio cloud cannot see its "
    + "rows — move it to the cloud from the projects list to render there",
  tier: true,
};

/* ── the local plane ────────────────────────────────────────────────────── */

/**
 * Why this machine will not render `c`, or null when it will.
 *
 * THE LADDER IS `renderableHere`'S, in its order and in its words, because
 * that function is what `planLanesHere` asks when it decides the lane the
 * blocks are queued on — so the picker and the queue cannot disagree about
 * where an episode is about to render. The deepest missing prerequisite is
 * named first: the sentence is the next thing to do rather than the last
 * thing that failed.
 */
export function localReason(
  c: WizardChoice, f: WizardFacts,
): WizardBlock | null {
  // THE MACHINE-WIDE RUNGS ARE `tier`-MARKED, and that is not cosmetic: they
  // are one fact about this computer, identical on every row, and a picker
  // that prints "the local engine's Python is not installed" beside each of
  // five models is the wall this rework exists to avoid. What stays per row is
  // what differs per row — a model's own missing weights, a key, Breeze.
  if (!f.desktop) {
    return { why: "the desktop app renders on your own machine — this is the web build",
             tier: true };
  }
  // Nobody has answered yet. Not a refusal and not a fix: saying anything here
  // would flash a reason at every desktop user for the length of one poll.
  if (!f.models) return { why: "", tier: true };
  if (!f.planner) {
    return { why: "the local engine's Python is not installed", fix: "engine", tier: true };
  }
  if (!f.ffmpeg) {
    return {
      why: "ffmpeg is not installed — the engine window has it under "
        + "“Utilities only”",
      fix: "engine",
      tier: true,
    };
  }
  const m = f.models.find((r) => r.key === c.key);
  // The map is GENERATED and pruned to what the engine window can fetch, so an
  // absent key is a real answer rather than a gap: Turbo's distillation needs
  // a node pack the installer does not add. No fix, because there is none the
  // user can perform.
  if (!m) {
    return { why: c.whyNoLocal
      ?? `this build cannot render ${c.name} on your own machine` };
  }
  if (!m.ready) {
    // NOTHING TO NAME is not "nothing missing" — it is an entry whose weights
    // the file scan cannot see at all (one that lives outside ComfyUI's tree).
    // "Not downloaded" would send someone to a download that does not exist.
    if (!m.missing.length) {
      return { why: `this build cannot tell which files ${c.name} needs` };
    }
    return {
      why: `not downloaded yet — ${m.missing.length} file(s) missing, `
        + `starting with ${m.missing[0]}`,
      fix: "models",
    };
  }
  return packReason(c, f);
}

/**
 * The node packs half of availability — `markFor`'s branch, applied per model.
 *
 * Two sentences because they have two fixes, which is that function's own
 * rule: a pack whose dependencies were REFUSED is excluded from `nodes` and
 * looks identical to one that was never installed, and "download it" about
 * files already on disk is what sends someone round a loop.
 */
export function packReason(
  c: WizardChoice, f: WizardFacts,
): WizardBlock | null {
  // Nobody has asked yet. An engine status that has not landed is not evidence
  // that a pack is absent, and refusing a row from one is how a picker tells a
  // machine it lacks something it has.
  if (!c.packs?.length || !f.nodes) return null;
  const missing = c.packs.filter((p) => !f.nodes!.includes(p));
  if (!missing.length) return null;
  const broken = missing.some((p) => f.nodesBroken?.includes(p));
  return {
    why: broken
      ? `a node pack it needs would not install (${missing.join(", ")}) — `
        + "reinstall the engine"
      : `reinstall the engine — it adds ${missing.join(" and ")} at install time`,
    fix: "engine",
  };
}

/**
 * THE LOCAL SPEECH ENGINES, keyed by the id a voice row carries.
 *
 * A TABLE RATHER THAN A BRANCH, for `voice_engines.py`'s own reason one plane
 * down: this used to read `breezeBlocked(f.breeze)` unconditionally, so the
 * day a second local engine shipped, its row would have reported BREEZE's
 * state — offering Qwen on a machine with no Qwen because Breeze happened to
 * be running, and refusing it on a machine where it was fine. Silent both
 * ways, since either answer is a plausible sentence about a speech engine.
 *
 * Keyed on `LOCAL_ENGINES`, which is the browser's copy of the worker's own
 * `ENGINES` and is pinned against it — so an engine added there and not here
 * is a failing test rather than a row that cannot explain itself.
 */
const LOCAL_SPEECH: Record<
  string, (f: WizardFacts) => WizardBlock | null | undefined
> = {
  // `undefined` from a closure means THIS BUILD HAS NOT ASKED, which is not
  // the same as "there is none" — see `WizardFacts.breeze`. Each reads its own
  // status field and its own `*Blocked`, so the two never share a status.
  breeze: (f) => (f.breeze === undefined ? undefined
    : speechBlock(breezeBlocked(f.breeze ?? null))),
  qwen: (f) => (f.qwen === undefined ? undefined
    : speechBlock(qwenBlocked(f.qwen ?? null))),
};

const speechBlock = (why: string | null): WizardBlock | null =>
  (why ? { why, fix: "speech" } : null);

/** Every local engine has a row above. Pinned so the two cannot drift. */
export const LOCAL_SPEECH_IDS = LOCAL_ENGINES;

/** Why the local plane will not RECORD the dialogue, or null when it will. */
export function localVoiceReason(
  c: WizardChoice, f: WizardFacts,
): WizardBlock | null {
  // A key of your own is the local plane too: `handlers/tts` runs here and
  // Rust hands the key straight to the child. It is answered before the engine
  // is, because a keyed provider needs none of it.
  if (c.provider && f.speechKeys.includes(c.provider)) return null;
  // Machine-wide, so `tier`-marked — see `localReason`.
  if (!f.desktop) {
    return { why: "the desktop app records on your own machine — this is the web build",
             tier: true };
  }
  if (!f.planner) {
    return { why: "the local engine's Python is not installed", fix: "engine", tier: true };
  }
  // Every line is synthesised at PLAN time to floor its shot, and `tts` is in
  // `FFMPEG_KINDS` — the clip is measured off the file.
  if (!f.ffmpeg) {
    return {
      why: "ffmpeg is not installed — the engine window has it under "
        + "“Utilities only”",
      fix: "engine",
      tier: true,
    };
  }
  if (!c.local) {
    return {
      why: `add your ${c.keyName ?? c.name} key to record on this machine`,
      fix: "keys",
    };
  }
  // A row flagged `local` with no entry here is one this function cannot
  // answer for — better to say nothing is known than to report the WRONG
  // engine's state, which is what a hardcoded Breeze lookup did the moment a
  // second local engine existed.
  const ask = LOCAL_SPEECH[c.id];
  if (!ask) return { why: "" };
  const block = ask(f);
  return block === undefined ? { why: "" } : block;
}

/* ── the two planes, resolved ───────────────────────────────────────────── */

/**
 * One row's tier and refusal.
 *
 * THE RULE IN ONE LINE: a row is LOCAL when this machine will actually claim
 * its work, and CLOUD otherwise — and the cloud is the studio's, which a
 * member cannot spend and a project living on this disk cannot reach.
 *
 * WHICH SENTENCE A BLOCKED CLOUD ROW SHOWS is `rowBlocked`'s own rule: the
 * local shortfall speaks only where it names a FIX, because there it is the
 * better sentence — it is something the reader can go and do, where "coming
 * soon" names nothing. A local reason with no fix (this build cannot render
 * Turbo here, ever) explains nothing about the cloud and is dropped.
 */
export function offerFor(
  c: WizardChoice, f: WizardFacts, tier: ModelTier,
  reason: (c: WizardChoice, f: WizardFacts) => WizardBlock | null,
): WizardOffer {
  const card = { ...c, tier, pick: pickOf(c.id, tier) };
  // A CARD IS REFUSED BY ITS OWN PLANE. The local one asks this machine, and
  // carries the download or the setup that fixes it; the cloud one asks the
  // account and the project and nothing else. A local shortfall says nothing
  // about whether the studio can render it — printing one under the studio's
  // heading was how "install the engine's Python" came to sit under Turbo,
  // naming a fix that would move nothing.
  if (tier !== "cloud") return { ...card, blocked: reason(c, f) };
  // A fact about the PROJECT rather than a permission, so it refuses an admin
  // too: the pod polls Supabase and these rows are a file on this disk.
  if (f.localProject) return { ...card, blocked: NO_POD_HERE };
  return { ...card, blocked: f.admin ? null : COMING_SOON };
}

/**
 * Every video CARD — each model on each plane that could serve it.
 *
 * WHAT GETS A LOCAL CARD: anything naming a `model_map` key, on a desktop.
 * That deliberately includes Turbo, which this build can never render here
 * (its distillation is applied through larryvrh's node pack, which the desktop
 * installer does not add, so the generator drops it) — the card says so, where
 * its absence from the section was a mystery. What gets none is the HOSTED
 * row, which is an API by construction and names no key at all.
 *
 * WHAT GETS A CLOUD CARD: everything except the quantised rungs, which exist
 * in the desktop map alone — the pod has a 96GB card, no reason to quantise
 * and none of these files, so a cloud card for one would be an episode that
 * dies on `not available on tier 'aws'`.
 */
export function videoOffers(
  choices: readonly WizardChoice[], f: WizardFacts,
): WizardOffer[] {
  const out: WizardOffer[] = [];
  for (const c of choices) {
    // A RUNG IS ONLY EVER OFFERED READY. See `WizardChoice.rung`.
    if (c.rung && !f.models?.some((r) => r.key === c.key && r.ready)) continue;
    if (f.desktop && c.key) out.push(offerFor(c, f, "local", localReason));
    if (c.home === "cloud") out.push(offerFor(c, f, "cloud", localReason));
  }
  return out;
}

/**
 * Every voice CARD, on the same rule.
 *
 * The plane is a real choice here too rather than a label: it decides whose
 * account records the lines. This machine's own Breeze and a key of your own
 * are `planLanes`' `speech`, which puts the `tts` jobs on this machine; the
 * studio's cloud is its own queue on its own bill. Breeze has an engine here,
 * ElevenLabs has a key, and the keyless offer is `byokOfferRows`' rule — a
 * section that appears only once a key is pasted reads as a build that cannot
 * do hosted work at all, when it is one paste away.
 */
export function voiceOffers(
  choices: readonly WizardChoice[], f: WizardFacts,
): WizardOffer[] {
  const out: WizardOffer[] = [];
  for (const c of choices) {
    if (f.desktop && (c.local || c.provider)) {
      out.push(offerFor(c, f, c.provider ? "byok" : "local", localVoiceReason));
    }
    if (c.home === "cloud") out.push(offerFor(c, f, "cloud", localVoiceReason));
  }
  return out;
}

/**
 * Which row to open on.
 *
 * A stored pick wins only while it is still pickable — `defaultPlace`'s rule,
 * and here it is load-bearing rather than tidy: the wizard's default is Turbo,
 * which on a member's machine is the studio's and refused, and a session
 * reopened after a model was deleted names one that is gone. Everything
 * blocked keeps the current value, which the picker then shows blocked with
 * its reason rather than silently substituting a model nobody chose.
 */
export function defaultChoice(
  offers: readonly WizardOffer[], current: string | null | undefined,
): string | null {
  const usable = offers.filter((o) => !o.blocked);
  if (usable.some((o) => o.pick === current)) return current ?? null;
  // A MODEL THAT SURVIVED ON THE OTHER PLANE KEEPS ITS MODEL. Falling straight
  // to the first pickable card would move somebody off H3 because their engine
  // went to sleep, when the studio renders the same model — so the plane moves
  // and the choice does not.
  const { id } = parsePick(current);
  return (usable.find((o) => o.id === id) ?? usable[0])?.pick ?? current ?? null;
}

/** The offer for an id, or null — so a caller reading `.blocked` cannot be
 *  reading it off the wrong row. */
export function pickedOffer(
  offers: readonly WizardOffer[], pick: string | null | undefined,
): WizardOffer | null {
  return offers.find((o) => o.pick === pick) ?? null;
}

/* ── the rows themselves ────────────────────────────────────────────────── */
//
// HERE RATHER THAN IN THE MODAL so the tests and `/ui/wizmodels` reason over
// the copy that ships. A hand-written fixture is worth what it SHARES with the
// real thing, and the thing being reviewed is which of these lands under which
// heading on a given machine.
//
// NO `where` FIELD ANY MORE. Every row used to carry one ("studio cloud", "on
// this machine") and it was a literal — wrong on the desktop for three of the
// five, and repeated five times where the section heading says it once.

export const VIDEO_CHOICES: readonly WizardChoice[] = [
  // Default, and listed first because of it. Same checkpoint, step-distilled
  // to 6. Measured on the pod at matched seed/prompt/dims: 111s -> 41s of
  // sampling per pass; across 109 real master passes it ran 8.2 min/block
  // against 14.8. Quoted as ~2x rather than a decimal, because the sampling
  // ratio and the whole-block ratio are not the same number and the user is
  // waiting on the block.
  //
  // STUDIO-ONLY, and that is the fact this rework surfaces: its distillation
  // is applied through larryvrh's node pack, which the desktop installer does
  // not add, so `gen_desktop_model_map.mjs` drops it and a machine with no pod
  // cannot render one block of it.
  { id: "h3-turbo-local", key: "minimax-h3-turbo", home: "cloud",
    // NOT A DOWNLOAD, which is why it is written out: the weights are the same
    // H3 already on disk, and what is missing is larryvrh's node pack — the
    // installer does not add it, so `gen_desktop_model_map.mjs` drops the
    // entry and `resolve.py` here could not build the graph if it were there.
    whyNoLocal: "its 6-step distillation needs larryvrh's node pack, which the "
      + "engine installer does not add — PDD is the fast one this machine can run",
    name: "MiniMax H3 · Turbo", price: "~2x faster · default",
    blurb: "Same model and audio, distilled to 6 sampling steps. Roughly halves a "
      + "render; very fast motion can smear where the full pass wouldn't." },
  // The OFFICIAL 8-step distillation (alibaba-pai PDD). A/B'd against Turbo on
  // real blocks: same speed, cleaner frames (none of Turbo's cross-dissolve
  // ghosting), and it ships a reference-mode build so episode blocks run it
  // end to end. Sampler and schedule are the distill's own (euler, 8 steps) —
  // the steps knob doesn't apply here. Unlike Turbo it needs no custom node,
  // so it is the fast option a laptop can actually run.
  { id: "h3-pdd-local", key: "minimax-h3-pdd", home: "cloud",
    // `MiniMaxH3PDDAccApply` — the files are not ordinary LoRAs (a per-interval
    // head bank a plain loader silently drops), so the pack IS the feature.
    packs: ["ComfyUI-MiniMax-H3-PDD-Acc"],
    name: "MiniMax H3 · PDD 8-step", price: "~2x faster · official distill",
    blurb: "MiniMax's official 8-step acceleration. Turbo speed with cleaner frames "
      + "in our tests, full reference mode and native audio. Newest option — "
      + "less production mileage than Turbo." },
  { id: "h3-local", key: "minimax-h3", home: "cloud",
    name: "MiniMax H3", price: "full 20-step pass",
    blurb: "15s passes with native synced audio, multi-shot timed prompts, identity "
      + "from refs. Choose this to master an episode you've already blocked out." },
  // Measured against H3 turbo on the same two beats, one seed: LTX obeys the
  // stated shot size and camera move (including the dutch angle and true
  // profile H3 refuses outright) and came back ~3x faster warm. What it costs
  // you is listed plainly — it can drop part of a beat's action, and with no
  // reference-audio input it cannot speak in a CAST voice, so an episode built
  // on dialogue_synth belongs on H3.
  { id: "ltx-25-local", key: "ltx-25", home: "cloud",
    // Reference mode is `ComfyUILTX25MSRMultiReferenceGuide`, and an EPISODE
    // block is r2v — so this is required here even though t2v needs none of it.
    packs: ["ComfyUI-LTX2.5-MSR"],
    name: "LTX 2.5", price: "~3x faster · obeys camera",
    blurb: "Follows stated shot sizes and camera moves far more reliably, with native "
      + "audio. Four character refs + a dedicated background slot. No cast-voice "
      + "refs, so dialogue is generated rather than in your character's voice." },
  // No `key`: there is no model_map entry to render locally, by construction.
  { id: "h3-api", home: "cloud",
    name: "MiniMax H3 · hosted", price: "per-second",
    blurb: "Same model via the official API — runs off the GPU entirely, 2K mastering." },
  // THE QUANTISED RUNGS. Desktop-only — see `WizardChoice.home` — and offered
  // only once downloaded, see `rung`.
  { id: "h3-q5-local", key: "minimax-h3-q5", home: "local", rung: true,
    // A GGUF needs `UnetLoaderGGUF`, which core does not have.
    packs: ["ComfyUI-GGUF"],
    name: "MiniMax H3 · Q5_K_M", price: "quantised · slow",
    blurb: "The closest quantisation to the official weights, and it renders inside a "
      + "hard 6GB of VRAM — but it wants about 31GB of system RAM to stream through, "
      + "and MEASURE THE TIME BEFORE COMMITTING: a 3-second block took roughly an "
      + "hour on a 16GB card at the full 20-step recipe. Reach for it when the "
      + "alternative is not rendering locally at all." },
  { id: "h3-q4-local", key: "minimax-h3-q4", home: "local", rung: true,
    // A GGUF needs `UnetLoaderGGUF`, which core does not have.
    packs: ["ComfyUI-GGUF"],
    name: "MiniMax H3 · Q4_K_M", price: "quantised · slow",
    blurb: "Some loss on fine detail for 21GB less system RAM than the full checkpoint "
      + "— the rung for a machine short of memory rather than short of card. Same "
      + "caveat as above: about an hour per 3-second block at 20 steps, measured." },
  { id: "h3-q3-local", key: "minimax-h3-q3", home: "local", rung: true,
    // A GGUF needs `UnetLoaderGGUF`, which core does not have.
    packs: ["ComfyUI-GGUF"],
    name: "MiniMax H3 · Q3_K_M", price: "quantised · smallest",
    blurb: "Lossy on a model whose whole point is fidelity, and the slowest of the "
      + "three — but the only one measured rendering inside a hard 6GB ceiling on "
      + "23GB of RAM." },
];

/**
 * The engine every character is CAST on at plan time, so the recorded lines
 * the shots are floored to come from it.
 *
 * Rows rather than a hidden default: they sound different, they are not
 * licensed alike, and a plan cast on the wrong one is a re-plan — the voice is
 * DESIGNED once per character and every line of the episode clones from it.
 *
 * THE TWO LOCAL ROWS ARE THE SAME SHAPE AND A DIFFERENT TRADE, which is the
 * whole reason both are offered: Breeze can steer a line's delivery and
 * perform its `(sigh)`, and its weights are non-commercial; Qwen3-TTS is
 * Apache 2.0 and can do neither. So the choice is licence against direction,
 * and it is not one this picker can make for anybody.
 */
export const VOICE_CHOICES: readonly WizardChoice[] = [
  // Both local engines have a service of their own on this machine — and the
  // pod runs the same models, so an install that has not happened yet keeps
  // the row on the studio's tier rather than blocking it.
  { id: "breeze", home: "cloud", local: true,
    name: "Breeze TTS 2", price: "free · designed voices",
    blurb: "Designs each character's voice from the writer's own description, directs "
      + "every line from its delivery note, and performs the (sigh) or (laugh) a "
      + "line carries. Research licence — non-commercial." },
  { id: "qwen", home: "cloud", local: true,
    name: "Qwen3-TTS 1.7B", price: "free · Apache 2.0",
    blurb: "Designs each character's voice from the writer's own description and "
      + "clones every line from it, exactly as Breeze does — and its weights are "
      + "Apache 2.0, so what it records is yours to sell. It cannot steer a line's "
      + "delivery or perform a (sigh): the note reaches the read through the "
      + "writer's punctuation alone." },
  { id: "elevenlabs", home: "cloud", provider: "elevenlabs", keyName: "ElevenLabs",
    name: "ElevenLabs v3", price: "per character",
    blurb: "Casts from a curated library and records whole exchanges as one "
      + "conversation. Delivery compiles to a v3 tag." },
];

/** The voice picker's section headings.
 *
 *  `TIER_META`'s own are written for model rows and name the wrong software
 *  over these two: Breeze is neither ComfyUI nor Ollama, and what the studio's
 *  cloud offers here is not a LoRA stack. */
export const VOICE_BLURBS = {
  local: "This computer's own speech service. Free, offline, and every line is "
    + "recorded before a single frame renders.",
  byok: "Driven from this machine on your own key, so it needs nothing of the "
    + "studio's. The vendor bills you directly.",
  cloud: "Recorded on the studio's own account — the same engines, on its bill "
    + "rather than yours.",
} as const;

// Where a render RUNS — and the models this machine can run itself.
//
// There are three planes now and the picker has to say which one it is
// offering, because they differ in every way that matters: who pays, what
// happens when you are offline, and whether custom workflows and LoRAs are
// even a thing.
//
//   CLOUD   the studio's own pod. `model_catalog.provider === "local"` — a
//           name that predates the desktop app and means "the studio's own
//           weights rather than someone's API". Custom graphs, LoRA stacks,
//           the whole storyboard pipeline. Runs on the studio's account.
//   LOCAL   the ComfyUI this app installed on THIS machine. Free, offline,
//           and bounded by the hardware. Not in `model_catalog` at all: what
//           is available is whatever has finished downloading, so the rows are
//           derived from `engineCatalog` × `engine_status`.
//   BYOK    someone else's API, on YOUR OWN KEY. Billed to you directly by the
//           vendor, and driven from this machine — so it works with the
//           studio's cloud switched off entirely. A closed box: no
//           LoRAs, no custom graph, no reference plumbing beyond what the
//           vendor exposes.
//   CLOUD   also covers a hosted row the STUDIO pays for. Same closed box,
//           different payer — which is the whole distinction, see below.
//
// The old picker showed one flat list in which the pod's models were labelled
// "local", so the one thing a desktop user most wanted to know — "is this
// running on my machine or on the render box" — was the one thing it did not
// say, and the model they had just downloaded was not in it at all.
import { isByokId } from "./byokCatalog.ts";
import type { EngineStatus } from "./desktop.ts";
import type { ModelCatalogRow } from "./db/types.ts";
import {
  FAMILIES, variantInstalled, variantFiles, variantMb,
  type FamilyAddon, type ModelFamily, type ModelVariant,
} from "./engineCatalog.ts";
import {
  localRecipe, NO_RECIPE, PARTIAL_RECIPE, RECIPES, samplingFor,
  type LocalRecipe, type Sampling,
} from "./localGraphs.ts";
import { loraDefs, lorasForFamily, type LocalLoraMap } from "./localLoras.ts";

/**
 * WHO PAYS AND WHERE IT RUNS — the two questions a picker has to answer first.
 *
 * `hosted` used to mean both "a vendor API the studio pays for" and "a vendor
 * API you pay for", which was fine only while the second did not exist. BYOK
 * made the word ambiguous in the one place ambiguity costs money: two rows for
 * the same model, identical on screen, one billed to the studio's quota and one
 * to your card.
 *
 * So the axis is the PAYER, not the vendor:
 *   local  this machine       — free, offline, bounded by the hardware
 *   byok   a vendor API       — your key, your bill, no pod involved
 *   cloud  the studio         — the studio's own machine and keys
 */
export type ModelTier = "cloud" | "local" | "byok";

export const TIER_META: Record<ModelTier, {
  label: string; where: string; blurb: string; cost: string;
}> = {
  local: {
    label: "On this machine", where: "your own hardware",
    blurb: "Your ComfyUI and your Ollama. Free, offline, and bounded by the machine.",
    cost: "free",
  },
  byok: {
    label: "Your API keys", where: "a provider, on your key",
    blurb: "Driven from this machine, so it needs nothing of the studio's. The vendor bills you directly.",
    cost: "your own key",
  },
  // A HOSTED MODEL NOBODY HERE HAS A KEY FOR. It is a real model and one
  // pasted key away, so it is listed rather than hidden — see `rowBlocked` —
  // and the heading says what would move it up a tier.
  cloud: {
    label: "Needs a key", where: "a provider you have not added yet",
    blurb: "Hosted models this machine holds no key for. Add one under API keys and they move up.",
    cost: "add a key",
  },
};

/** Tier order in every grouped list: NEAREST first.
 *
 *  Not cheapest-first, which stopped being decidable once one of the three
 *  costs real money on the user's own card. Nearest is still true and still
 *  useful: this machine, then a vendor this machine can call, then one it
 *  cannot call yet. */
export const TIER_ORDER: ModelTier[] = ["local", "byok", "cloud"];

/** Quality tiers a hosted row exposes, or [] when the knob would do nothing.
 *
 *  MEASURED, not assumed. gpt-image-2 on one panel prompt and one reference
 *  set: low 158 output tokens / $0.0304, medium 1,372 / $0.0668, high 5,488 /
 *  $0.1903 — a 6x spread, and the SHOT was correct at every tier (the POV, the
 *  restraint, the reaching hand, the portal). What scales is environmental
 *  detail, so for a storyboard panel — a reference for a video render rather
 *  than a deliverable — low is the tier that matters.
 *
 *  Only OpenAI's image rows take it. Gemini's take an `imageSize` ceiling
 *  instead (Lite serves 1K only), which is a per-model constant rather than a
 *  per-render choice, so offering this control there would be a knob that
 *  provably cannot change the render — the same rule GenComposer's negative
 *  prompt follows.
 */
export const QUALITY_TIERS = ["low", "medium", "high"] as const;
export type Quality = (typeof QUALITY_TIERS)[number];

export function qualityTiers(m: ModelCatalogRow | null | undefined): readonly Quality[] {
  // The knob is the VENDOR's, so it applies wherever an OpenAI row runs — on
  // your key or on the studio's. Keying it on the old `hosted` tier would have
  // silently removed the control the day BYOK renamed that tier.
  if (!m || tierOf(m) === "local") return [];
  return m.provider === "openai" ? QUALITY_TIERS : [];
}


export const LOCAL_PREFIX = "local:";

export const isLocalId = (id: string | null | undefined): boolean =>
  !!id && id.startsWith(LOCAL_PREFIX);

/**
 * Which plane a row runs on.
 *
 * `provider === "local"` is the POD, not this machine — that string is the
 * studio's own "we host these weights" flag and renaming it in the database
 * would touch the worker, the model map and every job ever written. A desktop
 * row is identified by its id instead, which nothing else can collide with
 * because a catalog id never contains a colon.
 */
export function tierOf(
  m: Pick<ModelCatalogRow, "id" | "provider"> & { capabilities?: Record<string, unknown> },
): ModelTier {
  if (isLocalId(m.id)) return "local";
  // A bundled-pipeline row this machine can run, or owns and cannot run right
  // now (`desktopRows`). `blocked` is local too: the weights are on THIS disk,
  // so the model is not somebody else's — only its engine is asleep, and
  // filing it under the studio's cloud would offer a fix nobody can perform.
  const desk = (m.capabilities as { desktop?: string } | undefined)?.desktop;
  if (desk === "ready" || desk === "blocked") return "local";
  // A user-added fal endpoint carries a `byok:` id; a catalog row the user has
  // a key for is marked by `byokRows`. Both are the same answer to "who pays".
  if (isByokId(m.id) || (m.capabilities as { byok?: boolean } | undefined)?.byok) return "byok";
  // Everything else is the studio's: its own pod (`provider === "local"`) and
  // any vendor row it holds the key for. Those ship `enabled: false` today, so
  // they render as a named, unavailable option rather than as a lie.
  return "cloud";
}

/* ── why a row cannot be picked ─────────────────────────────────────────── */
//
// HERE RATHER THAN IN THE PICKER because it is pure logic that three
// components and two libs consult, and because it has now been wrong twice in
// ways only a test would have caught — an OFFER read as a refusal, and before
// that a blocked row with no sentence. `TieredModelMenu` re-exports it, so
// every existing importer is untouched.

/** Where the fix for a blocked row lives — each one a tab of the engine
 *  window, which is where every setup decision on this build is made. */
export type RowFix = "keys" | "engine" | "models" | "speech";

export interface RowBlock { why: string; fix?: RowFix }

/**
 * Why this row cannot be picked, or null — and whether the user can fix it.
 *
 * NOTHING IS HIDDEN. A picker that drops a whole plane reads as a build with
 * nothing in it, and the row most worth showing is exactly the one that used
 * to disappear: a hosted model one pasted key away. So every row is listed,
 * every blocked one says why, and the ones with a fix the user can perform
 * become a button onto the screen that performs it.
 */
export function rowBlocked(m: ModelCatalogRow): RowBlock | null {
  const key = m.capabilities as { needsKey?: string; needsDesktop?: boolean } | undefined;
  if (key?.needsKey) {
    // WHERE THE KEY GOES MATTERS AS MUCH AS WHICH ONE. A browser tab has no
    // keychain to put it in and no keys screen to open — see `byokOfferRows`
    // — so naming the key alone there is a sentence with nowhere to go, which
    // is the refusal this function exists to end arriving from the other
    // side. The web row therefore carries NO `fix`, and that absence is what
    // renders it disabled instead of clickable.
    return key.needsDesktop
      ? { why: `add your ${key.needsKey} key in the desktop app` }
      : { why: `add your ${key.needsKey} key`, fix: "keys" };
  }
  // A BUNDLED-PIPELINE ROW CARRIES ITS OWN SENTENCE (`desktopRows.markFor`),
  // because "not downloaded", "the engine is asleep" and "a node pack would
  // not install" have three different fixes and one word for all three is
  // what leaves a user with nothing to do.
  const desk = m.capabilities as
    { desktop?: string; desktopWhy?: string; desktopFix?: "engine" | "models" | "speech" }
    | undefined;
  // BLOCKED means this machine OWNS it and cannot run it right now — the
  // weights are on this disk, only the engine is asleep — so it is a refusal
  // wherever the row sits, and it is checked first because its fix is the
  // specific one.
  if (desk?.desktop === "blocked" && desk.desktopWhy) {
    return { why: desk.desktopWhy, fix: desk.desktopFix };
  }
  // AN OFFER IS NOT A REFUSAL, and treating it as one is what put "download it
  // in the engine window — 3 file(s) missing" on studio-cloud rows the studio
  // renders perfectly well, greyed out, in place of their own capability line.
  // `markFor`'s own contract already says an offer "stays on the tier it was
  // already on, so an admin who wants the pod keeps the pod"; this branch
  // contradicted it. So an offer only ever speaks where the row would be
  // unusable ANYWAY — and there it is the better sentence, because it names a
  // fix the reader can perform where "coming soon" names none.
  const offer = desk?.desktop === "offer" && desk.desktopWhy
    ? { why: desk.desktopWhy, fix: desk.desktopFix } : null;
  // A HOSTED ROW WITH NO KEY ON THIS MACHINE. `byokRows` re-enables one the
  // moment its provider's key is in the keychain, so `enabled: false` here
  // means exactly "nothing can call this yet" — and the fix is one screen away,
  // which is why it is a button rather than a sentence.
  if (!m.enabled) {
    return offer ?? {
      why: (m.capabilities?.blocked as string)
        ?? `no ${m.provider} key on this machine — add one under API keys`,
      fix: m.provider ? "keys" : undefined,
    };
  }
  return null;
}

/**
 * Is this a row NOTHING ON THIS MACHINE CAN RUN?
 *
 * `tierOf` is the whole answer: `local` runs on this machine's own engine and
 * `byok` on a key in its keychain, which leaves `cloud` — a hosted model whose
 * provider key nobody has added. A picker still lists it (see `rowBlocked`);
 * what this decides is whether to WARN about a default nobody chose, which is
 * where the two most common answers in `NewProjectModal` used to combine into
 * a project whose every render is refused minutes later.
 *
 * An UNKNOWN row answers false: a catalog that has not loaded is not evidence
 * that a pick is unrunnable, and a warning invented from an empty list is
 * worse than none.
 */
export function unrunnableHere(m: ModelCatalogRow | null | undefined): boolean {
  if (!m) return false;
  return tierOf(m) === "cloud";
}

export const localId = (familyId: string, variantId: string) =>
  `${LOCAL_PREFIX}${familyId}/${variantId}`;

export function parseLocalId(id: string): { familyId: string; variantId: string } | null {
  if (!isLocalId(id)) return null;
  const [familyId, variantId] = id.slice(LOCAL_PREFIX.length).split("/");
  return familyId && variantId ? { familyId, variantId } : null;
}

export interface LocalPick {
  family: ModelFamily;
  variant: ModelVariant;
  recipe: LocalRecipe;
}

/** Resolve a `local:` id back to the catalogue entries and the recipe. Null
 *  when the id is not local, the family is gone, or nothing renders it. */
export function resolveLocal(id: string): LocalPick | null {
  const p = parseLocalId(id);
  if (!p) return null;
  const family = FAMILIES.find((f) => f.id === p.familyId);
  const variant = family?.variants.find((v) => v.id === p.variantId);
  const recipe = localRecipe(p.familyId);
  return family && variant && recipe ? { family, variant, recipe } : null;
}

/** Add-ons of a family that are (a) LoRA files, (b) fully on disk, and (c)
 *  applicable with the nodes this engine has.
 *
 *  (c) is not pedantry. H3's turbo v4 is applied as a runtime bypass by a node
 *  pack the local installer does not add; offered anyway it would load through
 *  `LoraLoaderModelOnly`, which its own blurb says rounds the delta away — so
 *  the pick would advertise 2.7x and deliver a worse render at the same speed.
 *  `nodes` is `engine_status.nodes`, i.e. the PACK directory names, so
 *  `needsPack` is named the same way — the granularity we actually have.
 *  Omitting `nodes` means "not checked" and keeps every addon, which is what
 *  the unit tests want. */
export function installedAddons(
  fam: ModelFamily, have: Set<string>, nodes?: Set<string>,
): FamilyAddon[] {
  return (fam.addons ?? []).filter((a) =>
    a.files.length > 0
    && a.files.every((f) => have.has(f.filename))
    && a.files.some((f) => f.dir === "loras")
    && (!a.needsPack || !nodes || nodes.has(a.needsPack)));
}

export const addonById = (fam: ModelFamily, id: string): FamilyAddon | undefined =>
  (fam.addons ?? []).find((a) => a.id === id);

/**
 * The engine-family → catalog-family mapping, so a local Wan gets the same
 * prompt guide a pod Wan does (`enhanceGuide` keys on `family`). Unmapped is
 * fine and honest: the guide reports `exact: false` and general craft is
 * applied, which is what the composer's wand tooltip already says.
 */
const GUIDE_FAMILY: Record<string, string> = {
  "wan22-5b": "wan2.2",
  "wan22-14b": "wan2.2",
  "wan21-1.3b": "wan2.2",
  krea2: "krea2",
  "minimax-h3": "minimax-h3",
  // The pod files this checkpoint under family `qwen`, and `enhanceGuide` keys
  // on that — an unmapped id would silently fall to general craft.
  "qwen-edit": "qwen",
  anima: "anima",
  "hidream-o1": "hidream_o1",
  flux2: "flux2",
  music3: "music3",
  acestep: "acestep",
  "stable-audio": "stable_audio",
  ltx25: "ltx-25",
};

/**
 * One catalog-shaped row per installed variant.
 *
 * Shaped as a `ModelCatalogRow` on purpose: the composer's mode list, size
 * ladder, reference cap, LoRA stack and prompt-guide lookup are all written
 * against that type, and a parallel "local model" type would mean a second
 * implementation of each — which is how the two halves drift.
 */
/**
 * IS THERE A ComfyUI TREE HERE AT ALL — ours installed, or one the user
 * linked. The single predicate every picker-facing decision goes through,
 * because "installed" alone is the wrong question since linking exists: a
 * linked setup has `installed: false` (we did not build it, so Start/Stop and
 * the installer stay off) and a full model tree — and gating rows on
 * `installed` is what made every picker show "No local engine installed yet"
 * over 17GB of weights.
 */
export const engineTree = (status: EngineStatus | null): boolean =>
  !!status && (status.installed || status.models_linked);

export function localModelRows(
  status: EngineStatus | null, registry?: LocalLoraMap,
): ModelCatalogRow[] {
  if (!engineTree(status)) return [];
  const have = new Set(status!.files ?? []);
  const nodes = new Set(status!.nodes ?? []);
  const rows: ModelCatalogRow[] = [];
  let sort = 0;

  for (const fam of FAMILIES) {
    const recipe = localRecipe(fam.id);
    if (!recipe) continue;              // see NO_RECIPE — reported, not rendered
    const addons = installedAddons(fam, have, nodes);
    // Everything the Civitai hub downloaded FOR THIS FAMILY that is still on
    // disk. Before this, a hub LoRA was a file in `models/loras/` that no
    // picker had ever heard of: `styleLoras` was built from `fam.addons`
    // alone. The two lists are concatenated rather than merged by key — an
    // addon id is never a filename, so they cannot collide.
    const hub = lorasForFamily(fam.id, have, registry);
    for (const v of fam.variants) {
      if (!variantInstalled(fam, v, have)) continue;
      // A GGUF without city96's loader is on disk and unusable. The engine
      // installer adds it, but an engine installed before that step existed
      // has the files and not the node — which reads as "the model is broken".
      const ggufReady = v.precision !== "gguf" || nodes.has("ComfyUI-GGUF");
      // Resolved once: the steps the row advertises and the cfg the negative
      // gate reads have to be the SAME sampling, or the row can promise a
      // control its own step count contradicts.
      const sampled = samplingFor(recipe, v.id);
      // R2V IS A SECOND CHECKPOINT, NOT A SECOND MODE. MiniMax trains `fl2va`
      // and `ref2va` separately and `fl2va` cannot read reference images at
      // all — so offering r2v without the reference weights on disk gets a
      // clip that renders beautifully and ignores every character sheet staged
      // into it. Withheld rather than degraded, the same rule `ggufReady`
      // follows one line up. A rung that declares no `refCheckpoint` has no
      // verified reference mode at all (DaSiWa) and never offers it.
      const refReady = !!v.refCheckpoint && have.has(v.refCheckpoint.filename);
      const modes = (refReady ? recipe.modes : recipe.modes.filter((m) => m !== "r2v"))
        // …AND THE SECOND REASON A MODE CAN BE UNAVAILABLE: a node pack rather
        // than a file. LTX 2.5's `r2v` is `ComfyUILTX25MSRMultiReferenceGuide`
        // + its IC-LoRA loader, both from a clone the engine installer adds —
        // so an engine installed before that step has every LTX weight and
        // cannot render one reference shot. Same withhold-rather-than-degrade
        // rule as `refReady` and `ggufReady`, keyed on `recipe.modePacks`.
        .filter((m) => {
          const pack = recipe.modePacks?.[m];
          return !pack || nodes.has(pack);
        });
      rows.push({
        id: localId(fam.id, v.id),
        family: GUIDE_FAMILY[fam.id] ?? fam.id,
        display_name: `${fam.name} · ${v.label}`,
        kind: recipe.kind,
        provider: "desktop",
        modes,
        sizes: recipe.sizes,
        max_seconds: recipe.maxSeconds ?? null,
        fps: recipe.fps ?? null,
        frame_base: recipe.frameBase ?? null,
        frame_rem: recipe.frameRem ?? null,
        dim_step: recipe.dimStep,
        pricing: {},                     // free: it is your electricity
        capabilities: {
          localFamily: fam.id,
          localVariant: v.id,
          vramGb: v.vram_gb,
          steps: sampled.steps,
          recipe: fam.recipe ?? null,
          // GATED ON THE RECIPE **AND THE EFFECTIVE CFG**, not hardcoded.
          // Two ways a negative can be inert and both occur here: the graph
          // may not wire a second encode at all (Krea 2 zeroes the positive,
          // H3 conditions through BasicGuider), and cfg may be 1, where the
          // uncond branch is never evaluated whatever is wired. The second is
          // PER VARIANT — Stable Audio's distilled checkpoints run cfg 1 and
          // their base twins run 7, off one recipe — so asking the family
          // alone would offer a field that provably cannot change the render
          // on half its own rows.
          negativePrompt: !!recipe.negative && sampled.cfg > 1,
          ...(recipe.negative && sampled.cfg > 1
            ? { defaultNegative: recipe.negative } : {}),
          ...(PARTIAL_RECIPE[fam.id] ? { note: PARTIAL_RECIPE[fam.id] } : {}),
          // Two was the cap while every adapter was a catalogue add-on and a
          // family declared at most three. A hub LoRA is a stackable concept
          // adapter — the reason `model_map` raised the video cap to 4 — so
          // the ceiling follows what is actually on offer.
          maxLoras: Math.max(2, Math.min(4, addons.length + hub.length)),
          styleLoras: [
            ...addons.map((a) => ({
              key: a.id,
              label: a.name,
              hint: a.recipe ? `${a.blurb} (${a.recipe})` : a.blurb,
            })),
            ...loraDefs(hub),
          ],
          ...(ggufReady ? {} : { blocked: "needs the GGUF loader — reinstall the engine" }),
        },
        enabled: ggufReady,
        sort: sort++,
      });
    }
  }
  return rows;
}

/**
 * How far down a local list the not-yet-downloaded rows sit.
 *
 * Above every installed row's `sort` (the whole catalogue is 57 variants), so
 * the surfaces that sort by it put what runs NOW over what would have to be
 * fetched — and the ones that do not sort inherit the same order from the
 * array `useLocalEngine` builds. Installed-but-unusable rows (a GGUF with no
 * loader) stay above the offers too, which is right: the gigabytes are already
 * paid for there and the fix is one pack rather than a download.
 */
const OFFER_SORT_BASE = 100;

/**
 * The local models this machine could run AFTER A DOWNLOAD — one row per
 * family whose weights are not here yet.
 *
 * `byokOfferRows`' shape and its reason. A list of what has finished
 * downloading answers "what can I run right now" and cannot answer the
 * question somebody opening a picker is usually asking, which is what this
 * machine can do AT ALL — so the local plane read as a build with two models
 * in it, and the way to find the other fifteen was to already know the engine
 * window exists. The row is listed, says what fetching it would cost, and
 * carries the `models` fix, which `TieredModelMenu` renders as a download icon
 * onto the engine window's Models tab.
 *
 * ONE ROW PER FAMILY, NOT PER RUNG — the wizard's rule (`WizardChoice.rung`)
 * and for its reason: a quantisation is an alternate of a model already named,
 * so five "download 13GB" rows under one another is the wall the grouping
 * exists to remove. Krea 2 alone would contribute five and Klein two more
 * fives. The engine window is where a rung is chosen against this machine's
 * own budget; a picker only has to say the model exists.
 *
 * A FAMILY WITH ANY RUNG ON DISK IS NOT OFFERED, and that is what makes the id
 * safe to reuse: `local:<family>/<first rung>` is a real id, and
 * `localModelRows` can only be emitting it when that rung is installed — so
 * the two lists can never name one row twice. It also means a machine whose
 * weights were deleted after the model was picked gets its own setting named
 * back at it, greyed and downloadable, where before the row vanished and the
 * picker showed the raw `local:…` id.
 *
 * GATED ON `engineTree`, like `localModelRows`. With no ComfyUI here at all
 * the weights are not the missing piece, and the empty-state line that says so
 * ("No local engine installed yet") is the honest answer — seventeen download
 * offers over a machine with nothing to run them is not.
 */
export function localOfferRows(status: EngineStatus | null): ModelCatalogRow[] {
  if (!engineTree(status)) return [];
  const have = new Set(status!.files ?? []);
  const rows: ModelCatalogRow[] = [];
  for (const fam of FAMILIES) {
    const recipe = localRecipe(fam.id);
    if (!recipe) continue;            // see NO_RECIPE — `localBlocked` names it
    if (fam.variants.some((v) => variantInstalled(fam, v, have))) continue;
    const first = fam.variants[0];
    if (!first) continue;
    // WHAT IT WOULD ACTUALLY COST is the CHEAPEST rung, not the first one.
    // `markFor` quotes `variants[0]` because its families have one; here the
    // first is the full-precision checkpoint, and quoting it is how a model
    // somebody could have run at 4.7GB reads as 13GB and never gets fetched.
    // "from", because which rung you take is the engine window's question.
    const gb = Math.min(...fam.variants.map((v) => variantMb(fam, v))) / 1024;
    rows.push({
      id: localId(fam.id, first.id),
      family: GUIDE_FAMILY[fam.id] ?? fam.id,
      // The FAMILY's name alone. An installed row is `${fam.name} · ${v.label}`
      // because a rung was chosen; nothing has been chosen here.
      display_name: fam.name,
      kind: recipe.kind,
      provider: "desktop",
      // The family's modes UNFILTERED, unlike an installed row's. Those are
      // narrowed by what is on disk (`refReady`, `modePacks`) because they
      // describe a render that is about to happen; this describes the model,
      // and narrowing it to nothing-is-installed would hide the download from
      // the two surfaces that filter by mode — which are exactly the ones
      // where "the chain picker has no local models" gets reported.
      modes: recipe.modes,
      sizes: recipe.sizes,
      max_seconds: recipe.maxSeconds ?? null,
      fps: recipe.fps ?? null,
      frame_base: recipe.frameBase ?? null,
      frame_rem: recipe.frameRem ?? null,
      dim_step: recipe.dimStep,
      pricing: {},                     // free: it is your electricity
      capabilities: {
        localFamily: fam.id,
        // `desktopRows.DesktopCaps`' own shape, so `rowBlocked` needs no new
        // branch — it already renders an offer as a greyed row carrying one
        // sentence and a fix. NOTHING ELSE: no `styleLoras`, no `vramGb`, no
        // step count. Those are facts about a rung nobody has picked, and a
        // row that cannot be selected has no business claiming them.
        desktop: "offer",
        desktopFamily: fam.id,
        desktopFix: "models",
        // THE SHORT FORM, unlike `markFor`'s and `imageVerdict`'s. Those
        // appear on one row at a time; this one repeats on every family a
        // machine has not fetched — eight of them in an image menu — and at
        // ~41 characters a line the full sentence wrapped to two, which put
        // the ONE fact that differs between the rows at the end of the second
        // line. "Get" is the engine window's own button label.
        desktopWhy: `get it in the engine window · from ${gb.toFixed(1)}GB`,
      },
      // FALSE IS LOAD-BEARING, not cosmetic: `rowBlocked` reaches its offer
      // branch through `!m.enabled`, and it is what sorts these under the rows
      // that run on every surface that sorts at all.
      enabled: false,
      sort: OFFER_SORT_BASE + rows.length,
    });
  }
  return rows;
}

/**
 * Families the machine has downloaded but cannot render, with the reason.
 *
 * Silence here is the failure mode: someone fetches 12GB of Krea 2, opens the
 * picker, finds nothing, and has no way to tell whether the download failed or
 * the app cannot drive it. Both of those are recoverable; not knowing which is
 * not.
 */
export function localBlocked(status: EngineStatus | null): { name: string; why: string }[] {
  if (!engineTree(status)) return [];
  const have = new Set(status!.files ?? []);
  const out: { name: string; why: string }[] = [];
  for (const fam of FAMILIES) {
    if (localRecipe(fam.id)) continue;
    if (!fam.variants.some((v) => variantInstalled(fam, v, have))) continue;
    out.push({ name: fam.name, why: NO_RECIPE[fam.id] ?? "no local recipe yet" });
  }
  return out;
}

/** Every weight file one local row needs, for the "what is missing" message. */
export const localFilesFor = (p: LocalPick): string[] =>
  variantFiles(p.family, p.variant).map((f) => f.filename);

/**
 * THE OTHER RENDERER, as something a page can inspect.
 *
 * There are two graph sources on the desktop and only one of them is a file:
 * the bundled Python resolves `workflows/*.json` for block renders, and
 * `localGraphs.ts` builds the graph in TypeScript for everything the composer
 * queues on `lane: "local"` — which is every model the engine window can
 * download. So "I have Wan installed and there is no workflow for it" was
 * exactly right and the answer was invisible: Wan's graph is a builder, ported
 * from templates no model_map names.
 *
 * Deliberately NOT gated on `engineTree`, unlike `localModelRows`. That one
 * answers "what can I pick right now" and must be empty without an engine;
 * this answers "what does this build know how to render", which is true of the
 * app rather than of the machine. What is installed rides along as an
 * annotation.
 */
export interface LocalRecipeRow {
  /** `engineCatalog` family id, which is also the RECIPES key */
  family: string;
  name: string;
  media: string;
  kind: LocalRecipe["kind"];
  modes: string[];
  sampling: Sampling;
  /** the template or graphs.py builder this was ported from */
  portedFrom: string[];
  /** each with its OWN resolved sampling — SDXL Turbo is 4 steps where Base
   *  is 30, and a family-level step count would be wrong for one of them */
  variants: { id: string; label: string; installed: boolean; sampling: Sampling }[];
  /** how many of them are on this machine */
  installed: number;
  license: string;
}

export function localRecipeRows(status: EngineStatus | null): LocalRecipeRow[] {
  const have = new Set(status?.files ?? []);
  const out: LocalRecipeRow[] = [];
  for (const fam of FAMILIES) {
    const recipe = localRecipe(fam.id);
    if (!recipe) continue;             // NO_RECIPE says why, and localBlocked shows it
    const variants = fam.variants.map((v) => ({
      id: v.id, label: v.label, installed: variantInstalled(fam, v, have),
      sampling: samplingFor(recipe, v.id),
    }));
    out.push({
      family: fam.id, name: fam.name, media: fam.media, kind: recipe.kind,
      modes: recipe.modes, sampling: recipe.sampling,
      portedFrom: recipe.portedFrom ?? [],
      variants, installed: variants.filter((v) => v.installed).length,
      license: fam.license,
    });
  }
  return out;
}

/**
 * Template filename -> the local families whose graph was ported from it.
 *
 * A template no model_map names reads as dead weight on every tier, and for
 * `wan22_5b_t2v.json` that is the opposite of true on a desktop: nothing
 * RESOLVES it, and it is the source of the recipe that renders Wan here.
 */
export function recipeSources(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [family, r] of Object.entries(RECIPES)) {
    for (const src of r.portedFrom ?? []) {
      if (!src.startsWith("workflows/")) continue;
      const file = src.slice("workflows/".length);
      out.set(file, [...(out.get(file) ?? []), family]);
    }
  }
  return out;
}

/**
 * Which catalogue rows this MACHINE can render, and what to say when it cannot.
 *
 * THE PROBLEM THIS SOLVES. Every other local model is a `local:` id minted by
 * `localModelRows` from what has finished downloading — a row that exists only
 * on this machine, for a family `localGraphs` can build. MMAudio is not that:
 * its whole tail (mux the new track onto the take, publish a derived `audio`
 * take, re-anchor the block) is `worker/handlers/v2a.py`, which the desktop
 * runs through the bundled pipeline exactly as the pod does. So it stays ONE
 * `model_catalog` row with one set of measured capabilities, and what changes
 * is WHERE the job is claimed.
 *
 * A MARK, NOT A SECOND ROW — the `markSpeechRows` convention. Appending would
 * list the same model twice with nothing to tell the copies apart; marking
 * moves it between tiers, which is the question a picker is actually asking.
 *
 * THE MARK CARRIES ITS OWN SENTENCE. `rowBlocked` only dispatches: this module
 * is the one place that knows the difference between "you have not downloaded
 * it", "the engine is not running" and "a node pack would not install", and
 * each of those has a different fix. A picker that collapses them says
 * "unavailable" and leaves the user with nothing to do.
 *
 * Pure and dependency-light on purpose: `node --test` reaches it, and every
 * state below is a case in `desktopRows.test.ts` rather than something only a
 * real machine can produce.
 */
import { FAMILIES, variantInstalled, type ModelFamily } from "./engineCatalog.ts";
import type { EngineStatus } from "./desktop.ts";
import { breezeBlocked, type BreezeStatus } from "./breezeLocal.ts";
import { qwenBlocked, type QwenStatus } from "./qwenLocal.ts";
import type { ModelCatalogRow } from "./db/types.ts";

/** Where the fix for a blocked row lives, as an engine-window tab. */
export type DesktopFix = "engine" | "models" | "speech";

/**
 * What this machine can say about a bundled-pipeline row.
 *
 *  - `ready`   — every file is on disk, every pack is usable, the engine is
 *                up and the pipeline's Python is installed. Renders here.
 *  - `blocked` — this machine OWNS it (the weights are downloaded) and cannot
 *                run it right now. Stays on the local tier, because the model
 *                is not somebody else's; only its engine is asleep.
 *  - `offer`   — it could run here after a download. Stays on the tier it was
 *                already on, so an admin who wants the pod keeps the pod.
 */
export type DesktopMark = "ready" | "blocked" | "offer";

export interface DesktopCtx {
  /** null off the desktop, or before the first status poll lands */
  status: EngineStatus | null;
  /** the bundled pipeline's Python is installed (`planner_ready`) */
  planner: boolean;
  /** ComfyUI is answering on this machine */
  engineUp: boolean;
  /** the local speech service, when this build has asked. A SERVICE rather
   *  than a `bundled` family — its own venv, its own torch, an HTTP API — so
   *  it is marked from its own status rather than from files on disk. */
  breeze?: BreezeStatus | null;
  /** the second local speech service, asked and marked separately — see
   *  `SPEECH_ROWS`. `undefined` = this build has not asked. */
  qwen?: QwenStatus | null;
}

/** What a marked row carries, under `capabilities`. */
export interface DesktopCaps {
  desktop?: DesktopMark;
  /** the whole sentence a picker shows — see the module note */
  desktopWhy?: string;
  desktopFix?: DesktopFix;
  /** the `engineCatalog` family id, for the download offer */
  desktopFamily?: string;
  /** the precision rung a READY row would render on, when the map declares
   *  another — see `DesktopRenderModel.rung`. Shown on the row, because a
   *  substitution nobody is told about is the bug this repo names most. */
  desktopRung?: string;
}

const caps = (m: ModelCatalogRow): DesktopCaps =>
  (m.capabilities ?? {}) as DesktopCaps;

/** True when this row renders on this machine right now. */
export const isDesktopReady = (m: ModelCatalogRow | null | undefined): boolean =>
  !!m && caps(m).desktop === "ready";

/** The families that render through the bundled pipeline rather than `localGraphs`. */
export const bundledFamilies = (): ModelFamily[] => FAMILIES.filter((f) => f.bundled);

/**
 * One family's verdict on this machine.
 *
 * Order matters and each branch is a different sentence. Nothing is returned
 * off the desktop or before a status lands — an unmarked row behaves exactly
 * as it did before this existed, which is what keeps the web build honest.
 */
export function markFor(
  fam: ModelFamily, ctx: DesktopCtx,
): { mark: DesktopMark; why: string; fix: DesktopFix } | null {
  const b = fam.bundled;
  if (!b || !ctx.status) return null;

  const have = new Set(ctx.status.files ?? []);
  const installed = fam.variants.some((v) => variantInstalled(fam, v, have));
  if (!installed) {
    // The weights are the big commitment, so this is an OFFER rather than a
    // block: the row goes on working wherever it already worked.
    const gb = (fam.variants[0]
      ? [...fam.shared, ...fam.variants[0].files].reduce((n, f) => n + f.size_mb, 0) / 1024
      : 0).toFixed(1);
    return { mark: "offer", fix: "models",
      why: `download ${fam.name} in the engine window (${gb}GB) to run it here` };
  }

  // A pack whose dependencies were refused is EXCLUDED from `nodes`, so this
  // catches it — but the fix is not the same as never having installed it,
  // and saying "download it" about files already on disk is the sentence that
  // sends someone round a loop.
  const nodes = new Set(ctx.status.nodes ?? []);
  const broken = new Set(ctx.status.nodes_broken ?? []);
  const missing = b.packs.filter((p) => !nodes.has(p));
  if (missing.length) {
    const wasBroken = missing.some((p) => broken.has(p));
    return { mark: "blocked", fix: "engine",
      why: wasBroken
        ? `a node pack it needs would not install (${missing.join(", ")}) — reinstall the engine`
        : `reinstall the engine — it adds ${missing.join(" and ")} at install time` };
  }

  // The pipeline's own Python, which is a different install from ComfyUI: a
  // machine that took "Utilities only", or brought its own ComfyUI, has the
  // weights and no runner.
  if (!ctx.planner) {
    return { mark: "blocked", fix: "engine",
      why: "install the studio's pipeline in the engine window to run it here" };
  }
  if (!ctx.engineUp) {
    return { mark: "blocked", fix: "engine", why: "start the engine to run it here" };
  }
  return { mark: "ready", fix: "engine", why: "" };
}

/** The catalogue row the local speech service turns on. */
export const BREEZE_ROW = "breeze-tts-2";
/** ...and the second one's. */
export const QWEN_ROW = "qwen3-tts";

/**
 * THE LOCAL SPEECH ROWS, each marked from its OWN service.
 *
 * A table for `wizardModels.LOCAL_SPEECH`'s reason: this was one hardcoded
 * Breeze lookup, so a second engine's row would have carried Breeze's verdict
 * — offered on a machine that has no Qwen because Breeze happened to be up,
 * and refused on one where it was fine. Both readings are plausible sentences
 * about a speech engine, so neither would have looked wrong.
 */
const SPEECH_ROWS: readonly {
  row: string;
  ask: (c: DesktopCtx) => { asked: boolean; why: string | null; installed: boolean };
}[] = [
  { row: BREEZE_ROW,
    ask: (c) => ({ asked: c.breeze !== undefined,
                   why: breezeBlocked(c.breeze ?? null),
                   installed: !!c.breeze?.installed }) },
  { row: QWEN_ROW,
    ask: (c) => ({ asked: c.qwen !== undefined,
                   why: qwenBlocked(c.qwen ?? null),
                   installed: !!c.qwen?.installed }) },
];

/** One row of `desktop_render_models`, as this module needs it. */
export interface RenderableModel {
  key: string;
  ready: boolean;
  missing: string[];
  /** the precision rung this machine would use, when not the declared one */
  rung?: string | null;
}

/**
 * Mark the IMAGE rows this machine can draw a reference sheet with.
 *
 * A DIFFERENT SOURCE FROM `markDesktopRows`, deliberately. That one asks
 * `engineCatalog` whether a family's files are downloaded, which is the right
 * question for a family written around one bundled pack. This one asks
 * `model_map.desktop.json` — because that is the table `resolve.py` will
 * actually resolve against, and the two DISAGREE: the map's generator drops
 * an entry whose files the engine window cannot fetch (Krea 2 goes, for one
 * encoder), so a row marked ready from the catalogue alone would be a sheet
 * that dies inside `resolve()` naming a file nobody can download.
 *
 * IT MARKS RATHER THAN MINTING A `local:` ID — the `markSpeechRows`
 * convention. The same weights are already reachable as a `local:` row for
 * the composer's one-off stills, and appending a second entry would list one
 * model twice with nothing to tell the copies apart. What the mark says is
 * narrower and more useful: this row's whole PIPELINE runs here.
 */
export function markDesktopImageRows(
  rows: ModelCatalogRow[],
  models: RenderableModel[] | null,
  ctx: { planner: boolean; engineUp: boolean;
         nodes?: string[] | null; nodesBroken?: string[] | null },
  keyOf: (id: string) => string | undefined,
): ModelCatalogRow[] {
  // Null is "nobody has asked yet" — off the desktop, or before the first
  // call lands. Marking from an absent answer would put "download it" on a
  // row the pod can already run.
  if (!models) return rows;
  const byKey = new Map(models.map((m) => [m.key, m]));
  for (const row of rows) {
    if (row.kind !== "image") continue;
    const m = byKey.get(keyOf(row.id) ?? "");
    if (!m) continue;
    // NOT READY AND NOTHING TO NAME is "this build cannot tell what it needs"
    // — an entry whose weights the file scan cannot see at all. It is not an
    // offer (there is no download to point at) and not a block (the machine
    // does not own it), so the row is left exactly as it was: the studio's,
    // which is where it can actually run. See `render_models_from`.
    if (!m.ready && !m.missing.length) continue;
    const c = (row.capabilities ?? {}) as DesktopCaps & Record<string, unknown>;
    const verdict = imageVerdict(m, ctx);
    c.desktop = verdict.mark;
    if (verdict.why) c.desktopWhy = verdict.why; else delete c.desktopWhy;
    c.desktopFix = verdict.fix;
    // Only where it would actually be loaded. An OFFER names a rung nothing
    // is going to render on, which would read as a claim about this machine.
    if (m.rung && verdict.mark !== "offer") c.desktopRung = rungLabel(m.rung);
    else delete c.desktopRung;
    row.capabilities = c as Record<string, unknown>;
  }
  return rows;
}

/**
 * A rung's own label, for the row that names it.
 *
 * The id (`klein4b-q4`) is what the generator, Rust and the render all key on
 * and it is not what anyone calls a checkpoint. The catalogue already carries
 * the name people use ("Q4_K_M"), and this module already reads the catalogue,
 * so the lookup happens once here rather than in each picker. Unknown ids fall
 * through unchanged — a build whose map is newer than its catalogue should
 * still say something true.
 */
export function rungLabel(id: string): string {
  for (const f of FAMILIES) {
    const v = f.variants.find((x) => x.id === id);
    if (v) return v.label;
  }
  return id;
}

/**
 * The custom node packs an IMAGE entry's graph needs, by model_map key.
 *
 * WEIGHTS ON DISK IS NOT AVAILABILITY, which the VIDEO picker has known since
 * it grew `WizardChoice.packs` and this one did not. `h3-image-pdd` inherits
 * MiniMax's 8-step distillation from `minimax-h3-pdd` through `from_model`,
 * and those files are not ordinary LoRAs — a per-interval head bank a plain
 * loader silently drops — so the pack IS the feature. Judged on files alone
 * the row reads READY, the wizard offers it, and every face and master plate
 * of the episode dies on `Node 'MiniMaxH3PDDAccApply' not found` with the
 * derived sheets and all forty panels cascading behind them. Measured on a
 * real local one-shot: 7 real failures, 111 dependents.
 *
 * `install_engine` DOES clone this pack, so an engine installed before it was
 * added to `NODE_PACKS` — or one whose clone failed, or a ComfyUI of the
 * user's own that this app never installs into — is exactly where it bites,
 * and none of those is visible from the model map.
 *
 * HAND-KEPT, pinned by `desktopRows.test.ts` against the map itself: every
 * image entry whose own or inherited shape declares a pack-bearing key has to
 * be in here. Directory names are `engine_status.nodes`' own spelling, i.e.
 * `engine.rs`'s `NODE_PACKS`.
 */
export const IMAGE_PACKS: Readonly<Record<string, readonly string[]>> = {
  "h3-image-pdd": ["ComfyUI-MiniMax-H3-PDD-Acc"],
  // Its DEFAULT unet is a GGUF, which core cannot load — `UnetLoaderGGUF` is
  // city96's. Unlike the rungs below, this one is true whatever is chosen.
  flux2: ["ComfyUI-GGUF"],
};

/** The GGUF loader, named once so the two places that require it agree. */
const GGUF_PACK = "ComfyUI-GGUF";

/**
 * The packs a row needs AS IT WOULD RENDER RIGHT NOW.
 *
 * A quantised rung is the second half of the same question and it is not in
 * the table above, because it is not a property of the entry: `flux2-klein-4b`
 * loads a safetensors by default and a `.gguf` the moment its Q rung is the
 * one on disk, and `DesktopRenderModel.rung` is what says which. So the
 * requirement is read off the variant that would actually load.
 */
export function packsFor(m: RenderableModel): string[] {
  const want = [...(IMAGE_PACKS[m.key] ?? [])];
  if (m.rung) {
    for (const f of FAMILIES) {
      const v = f.variants.find((x) => x.id === m.rung);
      if (!v) continue;
      const gguf = [...f.shared, ...v.files].some((x) => x.filename.endsWith(".gguf"));
      if (gguf && !want.includes(GGUF_PACK)) want.push(GGUF_PACK);
      break;
    }
  }
  return want;
}

/** One image row's verdict. Same three marks and the same ordering rule as
 *  `markFor`: what is MISSING is an offer (the row keeps the tier it had),
 *  what is merely asleep is a block on the local tier. */
export function imageVerdict(
  m: RenderableModel,
  ctx: { planner: boolean; engineUp: boolean;
         nodes?: string[] | null; nodesBroken?: string[] | null },
): { mark: DesktopMark; why: string; fix: DesktopFix } {
  if (!m.ready) {
    return { mark: "offer", fix: "models",
      why: `download it in the engine window to draw sheets here — ${m.missing.length} `
         + `file(s) missing, starting with ${m.missing[0]}` };
  }
  // Null is "nobody has asked yet", not "nothing is installed" — judging a row
  // against an empty list before the first status lands would block every
  // pack-bearing model for a frame and then unblock it, which reads as a
  // flicker and gets clicked through.
  const want = packsFor(m);
  if (want.length && ctx.nodes) {
    const have = new Set(ctx.nodes);
    const broken = new Set(ctx.nodesBroken ?? []);
    const missing = want.filter((pk) => !have.has(pk));
    if (missing.length) {
      // A pack whose dependencies were REFUSED is excluded from `nodes` too,
      // and its fix is not the same as never having installed it — "download
      // it" about files already on disk is the sentence that sends someone
      // round a loop. `markFor`'s wording, so the two bars agree.
      return { mark: "blocked", fix: "engine",
        why: missing.some((pk) => broken.has(pk))
          ? `a node pack it needs would not install (${missing.join(", ")}) — `
            + "reinstall the engine"
          : `reinstall the engine — it adds ${missing.join(" and ")} at install time` };
    }
  }
  // The pipeline's own Python, which is a different install from ComfyUI: a
  // machine that took "Utilities only", or brought its own ComfyUI, has the
  // weights and no runner.
  if (!ctx.planner) {
    return { mark: "blocked", fix: "engine",
      why: "install the studio's pipeline in the engine window to run it here" };
  }
  if (!ctx.engineUp) {
    return { mark: "blocked", fix: "engine", why: "start the engine to run it here" };
  }
  return { mark: "ready", fix: "engine", why: "" };
}

/**
 * Mark every bundled-pipeline row in a catalogue.
 *
 * IN PLACE, like `markSpeechRows`, and for its reason: the rows are a cached
 * shared array and a copy would have to be re-marked by every caller that
 * touches it. Returns the same array so it composes.
 */
export function markDesktopRows(
  rows: ModelCatalogRow[], ctx: DesktopCtx,
): ModelCatalogRow[] {
  // THE SPEECH SERVICE IS MARKED FROM ITS OWN STATUS, not from `engine_status`
  // — it has no weights in a ComfyUI directory and no node pack, and the
  // question "can this machine speak" is answered by whether it is serving.
  // Only when this build has actually asked: `breeze: undefined` means the
  // caller has no opinion, and marking a row from an absent answer would put
  // "install it" on a row the pod can already run.
  for (const svc of SPEECH_ROWS) {
    const { asked, why, installed } = svc.ask(ctx);
    if (!asked) continue;
    const row = rows.find((r) => r.id === svc.row);
    if (!row) continue;
    const c = (row.capabilities ?? {}) as DesktopCaps & Record<string, unknown>;
    // INSTALLED-BUT-BLOCKED and NOT-INSTALLED are different offers: one is
    // "start it", the other "download it", and `rowBlocked` renders them
    // differently. Reading the flag off the wrong service is what a single
    // hardcoded lookup did.
    c.desktop = why ? (installed ? "blocked" : "offer") : "ready";
    c.desktopFix = "speech";
    if (why) c.desktopWhy = why;
    else delete c.desktopWhy;
    row.capabilities = c as Record<string, unknown>;
  }
  if (!ctx.status) return rows;
  for (const fam of bundledFamilies()) {
    const verdict = markFor(fam, ctx);
    if (!verdict) continue;
    const row = rows.find((r) => r.id === fam.bundled!.catalogRow);
    if (!row) continue;
    const c = (row.capabilities ?? {}) as DesktopCaps & Record<string, unknown>;
    c.desktop = verdict.mark;
    c.desktopFamily = fam.id;
    if (verdict.why) c.desktopWhy = verdict.why;
    else delete c.desktopWhy;
    c.desktopFix = verdict.fix;
    row.capabilities = c as Record<string, unknown>;
  }
  return rows;
}

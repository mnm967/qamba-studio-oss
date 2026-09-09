// LoRAs this machine downloaded from the hub, and the one thing the engine
// cannot tell us about them: which model they are for.
//
// THE BUG THIS EXISTS TO FIX. Downloading a LoRA from the Civitai hub worked
// perfectly — the file landed in `models/loras/` and showed up in
// `engine_status.files` — and then nothing on any screen ever mentioned it
// again. Every picker reads `capabilities.styleLoras`; for a desktop row that
// was built by `localModels.installedAddons()`, which only ever reads the
// hardcoded `fam.addons` in `engineCatalog.ts`. And `localRender` resolved a
// pick with `addonById(family, key)`, so an unrecognised key was dropped by a
// `.filter()` with no log and no error. A LoRA was a file on disk and nothing
// else.
//
// WHY A REGISTRY AND NOT JUST THE DIRECTORY LISTING. `models/loras/` gives
// filenames. A picker needs to know WHICH FAMILY each one is for — offering an
// SD 1.5 LoRA on a Wan render is a `ERROR lora` line at best and a silently
// unstyled render at worst — and nothing in the file's name says. Civitai does
// say, in `baseModel`, so that is captured at download time and kept.
//
// WHY localStorage AND NOT A TABLE. The file is on THIS machine's disk. A
// Supabase table would be per-account (so it would be wrong the moment two
// people share a login, and empty when signed out), would not exist for a
// local-plane project, and would go stale the moment someone deleted the file
// by hand. Same reasoning as `autoSync`'s `syncedAt` marker: a fact about this
// install belongs to this install.
//
// EXISTENCE IS ALWAYS THE DISK, NEVER THIS FILE. Every read intersects the
// registry with `engine_status.files`, so deleting a LoRA from the folder
// removes it from the picker with no bookkeeping — and a cleared browser store
// costs the metadata, not the file. That asymmetry is deliberate: a stale
// entry pointing at a file that is gone would be a picker row whose render
// fails, which is the failure this whole module exists to remove.
import type { LoraDef } from "../components/ui/ImageModelPicker.tsx";
import { pickFromAddon, type LoraPick } from "./localGraphs.ts";
import { FAMILIES, type FamilyAddon, type ModelFamily } from "./engineCatalog.ts";

const LS_KEY = "qamba.local.loras";

export interface LocalLora {
  /** The file in `models/loras/`. It is ALSO the pick key — see `loraKey`. */
  filename: string;
  /** `engineCatalog` family id this LoRA is for. */
  family: string;
  /** What to call it in the picker. */
  name: string;
  /** The author's trigger word, when they published one. Shown, never
   *  prepended — see `hintFor`. */
  trigger?: string;
  /** Civitai's own `baseModel` string, verbatim. Kept because the mapping to a
   *  family is lossy in one direction (a T2V-A14B adapter maps onto the I2V
   *  row — same architecture, different checkpoint) and the honest thing is to
   *  show what the author actually tagged rather than only our reading of it. */
  baseModel?: string;
  /** `civitai/<modelId>`, for the card and for de-duplication of a re-download. */
  source?: string;
  /** The author's suggested strength, when they published one. */
  strength?: number;
}

export type LocalLoraMap = Record<string, LocalLora>;

/**
 * A pick key IS the filename.
 *
 * The studio's rule that "filenames never reach the browser" is about the POD:
 * there, `style_loras` maps an opaque key to a file the browser has no business
 * knowing. Here the file is on the user's own disk, they chose it by name in
 * the hub, and `LoraLoaderModelOnly` needs the name anyway — so an indirection
 * would be a lookup table that can only ever go wrong. Addon ids never collide
 * with it: none of them ends in `.safetensors`.
 */
export const loraKey = (l: LocalLora): string => l.filename;

/* ── which family a Civitai tag means ───────────────────────────────────── */

/**
 * Civitai's `baseModel` → an `engineCatalog` family id.
 *
 * MEASURED, not guessed: the keys are the strings the live API actually
 * returns, counted over the 100 most-downloaded LoRAs plus targeted queries
 * (2026-08-28). "SD 1.5" 412, "Pony" 287, "Illustrious" 175, "SDXL 1.0" 107,
 * "NoobAI" 61, "Krea 2" 48, "MiniMax H3" 17, "Wan Video 2.2 I2V-A14B" 46.
 *
 * AMBIGUITY IS A MISS, NOT A GUESS — the rule `match_brief_name` follows. Two
 * cases are deliberately absent:
 *   - bare "Wan Video", which names no generation and no size;
 *   - "Wan Video 14B t2v" / "…i2v 720p" / "…i2v 480p", which are Wan **2.1**
 *     14B — a family this catalogue does not carry at all. Mapping them onto
 *     the 2.2 A14B row would load an adapter trained on different weights.
 * Both fall through to null, and the download screen then ASKS.
 */
const BASE_MODEL_FAMILY: Record<string, string> = {
  "sd 1.4": "sd15",
  "sd 1.5": "sd15",
  "sd 1.5 lcm": "sd15",
  "sd 1.5 hyper": "sd15",
  "sdxl 1.0": "sdxl",
  "sdxl turbo": "sdxl",
  "sdxl lightning": "sdxl",
  "sdxl hyper": "sdxl",
  // Pony, Illustrious and NoobAI are SDXL-architecture finetunes: an adapter
  // for one loads on the others, which is why they are one row here.
  pony: "sdxl",
  illustrious: "sdxl",
  noobai: "sdxl",
  "krea 2": "krea2",
  "minimax h3": "minimax-h3",
  "wan video 1.3b t2v": "wan21-1.3b",
  "wan video 2.2 ti2v-5b": "wan22-5b",
  "wan video 2.2 i2v-a14b": "wan22-14b",
  // Same A14B architecture and the same 5120 width, so it loads; it is a
  // different checkpoint of the pair, which is why `baseModel` is kept and
  // shown rather than being folded away.
  "wan video 2.2 t2v-a14b": "wan22-14b",
};

/** The family a Civitai `baseModel` names, or null when nothing here is a
 *  confident match. Null is an answer: the caller asks the user. */
export function familyForBaseModel(baseModel: string | null | undefined): string | null {
  const k = (baseModel ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return BASE_MODEL_FAMILY[k] ?? null;
}

/* ── the store ──────────────────────────────────────────────────────────── */

/** Everything registered on this machine, keyed by filename. Never throws:
 *  storage can be disabled, and a LoRA registry is not worth a blank screen. */
export function allLocalLoras(): LocalLoraMap {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as unknown;
    return sanitise(raw);
  } catch {
    return {};
  }
}

/** Drop anything that is not a usable record. The store is JSON a previous
 *  version wrote, so it is treated as untrusted input rather than as a type. */
export function sanitise(raw: unknown): LocalLoraMap {
  const out: LocalLoraMap = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const l = v as Partial<LocalLora>;
    if (!l || typeof l !== "object") continue;
    if (typeof l.filename !== "string" || !l.filename) continue;
    if (typeof l.family !== "string" || !l.family) continue;
    out[k] = {
      filename: l.filename,
      family: l.family,
      name: typeof l.name === "string" && l.name ? l.name : l.filename,
      ...(typeof l.trigger === "string" && l.trigger ? { trigger: l.trigger } : {}),
      ...(typeof l.baseModel === "string" ? { baseModel: l.baseModel } : {}),
      ...(typeof l.source === "string" ? { source: l.source } : {}),
      ...(Number.isFinite(l.strength) ? { strength: Number(l.strength) } : {}),
    };
  }
  return out;
}

/** Add or replace one record. Keyed by filename, so re-downloading the same
 *  file corrects the entry rather than making a second one. */
export function registerLocalLora(l: LocalLora): void {
  try {
    const all = allLocalLoras();
    all[l.filename] = sanitise({ x: l }).x ?? l;
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch { /* storage disabled — the file still downloads */ }
}

export function forgetLocalLora(filename: string): void {
  try {
    const all = allLocalLoras();
    delete all[filename];
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch { /* storage disabled */ }
}

/* ── what the pickers and the renderer read ─────────────────────────────── */

/**
 * The registered LoRAs for one family that are ACTUALLY ON DISK.
 *
 * `have` is `engine_status.files`, which is the only honest source for
 * existence — see the header. Sorted by name so the picker does not reshuffle
 * itself between renders.
 */
export function lorasForFamily(
  familyId: string, have: Set<string>, all: LocalLoraMap = allLocalLoras(),
): LocalLora[] {
  return Object.values(all)
    .filter((l) => l.family === familyId && have.has(l.filename))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Registered LoRAs whose FILE is gone. Reported so the hub can offer to
 *  forget them, rather than leaving rows that quietly never appear. */
export function orphanedLoras(have: Set<string>, all: LocalLoraMap = allLocalLoras()): LocalLora[] {
  return Object.values(all).filter((l) => !have.has(l.filename));
}

/**
 * The picker hint.
 *
 * THE TRIGGER IS SHOWN, NEVER PREPENDED. The pod's image path prepends one
 * (`images._resolve_loras`) because it composes the whole prompt itself; here
 * the prompt is the user's own text sent verbatim, and silently rewriting it
 * is the kind of invisible edit this codebase keeps deciding against. Putting
 * the token where it can be read and typed is the honest half of that trade —
 * without it the adapter loads and appears to do nothing.
 */
export function hintFor(l: LocalLora): string {
  const bits: string[] = [];
  if (l.trigger) bits.push(`say "${l.trigger}" in the prompt`);
  if (l.baseModel) bits.push(`tagged ${l.baseModel}`);
  bits.push("from the hub");
  return bits.join(" · ");
}

/** The `capabilities.styleLoras` entries for one family's downloaded LoRAs. */
export function loraDefs(loras: LocalLora[]): LoraDef[] {
  return loras.map((l) => ({
    key: loraKey(l),
    label: l.name,
    hint: hintFor(l),
    ...(l.trigger ? { trigger: l.trigger } : {}),
    // The author's own suggested weight, where they published one. `LoraDef`
    // uses it as the slider's starting point — not every adapter wants 1.0.
    ...(Number.isFinite(l.strength) ? { strength: Number(l.strength) } : {}),
  }));
}

/* ── what a render resolves a pick to ───────────────────────────────────── */

export class LoraResolveError extends Error {}

/**
 * Turn the composer's `payload.loras` into files the graph can load.
 *
 * TWO SOURCES, ONE SHAPE. A catalogue add-on and a hub download are
 * indistinguishable by the time `spliceLoras` sees them, which is the whole
 * point: the bug this replaces was `localRender` resolving only the first
 * kind and dropping the second with a `.filter()`.
 *
 * AN UNRESOLVABLE PICK RAISES. Falling through renders the shot without the
 * adapter the user chose and says nothing — the silent downgrade this codebase
 * keeps naming, and the same call `resolve.lora_stack` makes on the pod.
 *
 * `onDisk` is null when nobody asked the engine what it holds (the unit tests
 * have no engine); a supplied set is ENFORCED, so a file deleted by hand
 * behaves like one that was never there.
 */
export function resolveLoraPicks(
  fam: Pick<ModelFamily, "id" | "name">,
  picks: { key: string; strength?: number }[],
  opts: {
    addon: (key: string) => FamilyAddon | undefined;
    registry?: LocalLoraMap;
    onDisk?: Set<string> | null;
  },
): LoraPick[] {
  const registry = opts.registry ?? allLocalLoras();
  const onDisk = opts.onDisk ?? null;
  return picks.map((p) => {
    const strength = p.strength ?? 1;
    const addon = opts.addon(p.key);
    if (addon) return pickFromAddon(addon, strength);
    const own = registry[p.key];
    if (!own) {
      throw new LoraResolveError(
        `"${p.key}" is not an adapter this machine has for ${fam.name}`);
    }
    // Not paranoia: an SD 1.5 adapter on a Wan render matches no layer, loads
    // nothing, and logs a wall of shape errors that reads like a broken job.
    if (own.family !== fam.id) {
      throw new LoraResolveError(`"${own.name}" is for ${own.family}, not ${fam.id}`);
    }
    if (onDisk && !onDisk.has(own.filename)) {
      throw new LoraResolveError(
        `"${own.name}" is registered but ${own.filename} is not on disk`);
    }
    return { files: [own.filename], strength };
  });
}

/* ── hub LoRAs on a POD-CATALOGUE video row (desktop episode renders) ────── */

/**
 * Offer this machine's downloaded LoRAs on a catalogue VIDEO row.
 *
 * A desktop episode render is the one path where the two halves of this file
 * did not meet. The composer's picker is built from `localModels`, which
 * already appends `loraDefs(lorasForFamily(...))` to every `local:` row — but
 * an EPISODE renders through `master_pass`, which is the bundled Python, which
 * resolves against `infra/model_map.desktop.json`, whose every `style_loras`
 * table was pruned by the generator (the studio's own adapter files are not
 * things the engine window can download). So a hub LoRA was offered for a
 * one-off clip and silently unavailable for the episode made of the same
 * shots.
 *
 * It needs no worker change, because `resolve.lora_stack` already ends with:
 *
 *     if entry is None and key.endswith(".safetensors"): entry = key
 *
 * — an escape hatch written for a file dropped on the pod by hand, and a
 * filename is exactly what `loraKey` is. So a pick made here resolves against
 * whatever `models/loras` the engine is reading, which on this machine is
 * where the hub put it.
 *
 * WHICH FAMILY a catalogue row belongs to is matched by PREFIX, because the
 * catalogue splits what the engine catalogue does not: `minimax-h3-turbo` and
 * `minimax-h3-pdd` are the same weights with a distillation on top, and an
 * adapter downloaded for the family works on all of them. Longest match wins,
 * so a genuinely distinct family whose id happens to extend another's is not
 * silently handed the wrong adapters.
 */
export function withDesktopVideoLoras<T extends {
  id: string; capabilities?: Record<string, unknown> | null;
}>(row: T | null | undefined, modelKey: string | undefined,
   have: Set<string>, all: LocalLoraMap = allLocalLoras()): T | null | undefined {
  if (!row || !modelKey) return row;
  const fam = familyIdForModelKey(modelKey);
  if (!fam) return row;
  const hub = lorasForFamily(fam, have, all);
  if (!hub.length) return row;

  const caps = (row.capabilities ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(caps.styleLoras) ? (caps.styleLoras as LoraDef[]) : [];
  // Keys are filenames and a catalogue key never is one, so a hub adapter can
  // never shadow a studio one — but a second copy of the SAME file would give
  // the picker two rows that load one adapter twice at compounding strength.
  const seen = new Set(existing.map((d) => d.key));
  const added = loraDefs(hub).filter((d) => !seen.has(d.key));
  if (!added.length) return row;

  return {
    ...row,
    capabilities: {
      ...caps,
      styleLoras: [...existing, ...added],
      // Same reasoning as `localModelRows`: the cap was written when every
      // adapter was the studio's, and it must not refuse a stack the user
      // assembled out of their own files.
      maxLoras: Math.max(Number(caps.maxLoras ?? 0) || 0, Math.min(4, existing.length + added.length)),
    },
  };
}

/** The `engineCatalog` family a model_map key renders on, or null. */
export function familyIdForModelKey(modelKey: string): string | null {
  let best: string | null = null;
  for (const f of FAMILIES) {
    if (modelKey === f.id || modelKey.startsWith(`${f.id}-`)) {
      if (!best || f.id.length > best.length) best = f.id;
    }
  }
  return best;
}

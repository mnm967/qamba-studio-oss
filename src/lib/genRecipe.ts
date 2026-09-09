// "Make another one like that" — the recipe behind a generated asset.
//
// Everything a generation needed is already on the jobs row that produced it
// (invariant #1: the job IS the generation), so reuse is a read, not a record
// we have to start keeping: prompt, model, mode, size, seed, LoRA stack and
// the reference set all come back off `assets.source_job_id`.
//
// The composer is the only thing that can act on this, but it deliberately
// knows nothing about the grid above it, so a card hands the recipe over
// through the workspace store and the composer applies it.
import { supabase } from "./supabase";
import { loadAssetsByIds } from "./db/assets";
import type { LoraPick } from "./projectSettings";
import type { Asset, Job } from "./db/types";

export interface GenPreset {
  /** identity of one hand-off, so the composer applies it exactly once */
  token: string;
  kind: "image" | "video";
  /** catalog id off the job; `modelKey` is the model_map key it sent */
  modelId: string | null;
  modelKey: string | null;
  mode: string | null;
  prompt: string;
  /** the job's own negative, when it carried one. Absent on every job whose
   *  model doesn't sample a negative branch, and on anything that took the
   *  model's default — in both cases the composer keeps showing "default"
   *  rather than inventing a string the render never saw. */
  negative: string | null;
  width: number | null;
  height: number | null;
  seed: number | null;
  durationMs: number | null;
  loras: LoraPick[];
  refs: Asset[];
  start: Asset | null;
  end: Asset | null;
  /** what it was reused from, for the composer's hint line */
  label: string;
  /** references the job used that have since been deleted */
  lostRefs: number;
}

type Payload = Record<string, unknown>;

const str = (v: unknown): string | null =>
  (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null =>
  (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

/** The LoRA stack as the worker reads it: the `loras` array first, then the
 *  single legacy `lora`, which lands at the end of the stack. Keys, never
 *  filenames — a key the target model doesn't declare is dropped later by
 *  `validLoras`, exactly as it would be dropped by the worker. */
function loraStack(p: Payload): LoraPick[] {
  const out: LoraPick[] = [];
  for (const l of (Array.isArray(p.loras) ? p.loras : [])) {
    const o = (typeof l === "object" && l ? l : {}) as { key?: string; strength?: number };
    const key = typeof l === "string" ? l : str(o.key);
    if (key) out.push({ key, strength: Number(o.strength ?? 1) || 1 });
  }
  const single = str(p.lora);
  if (single) out.push({ key: single, strength: Number(p.lora_strength ?? 1) || 1 });
  return out;
}

/** Reference ids in both shapes: the composer's flat `ref_asset_ids` and the
 *  storyboard's `ref_assets[{asset_id,purpose}]`. */
function refIds(p: Payload): string[] {
  const flat = (Array.isArray(p.ref_asset_ids) ? p.ref_asset_ids : []) as unknown[];
  const planned = (Array.isArray(p.ref_assets) ? p.ref_assets : []) as { asset_id?: string }[];
  return [...new Set([
    ...flat.map(str).filter(Boolean) as string[],
    ...planned.map((r) => str(r?.asset_id)).filter(Boolean) as string[],
  ])];
}

/** Read the recipe behind one generated asset.
 *
 *  Throws only when there is nothing to read — a deleted job row, or an asset
 *  that was uploaded rather than generated. Everything else degrades: a job
 *  that predates a field just leaves that field null and the composer keeps
 *  its own value for it. */
export async function recipeFor(asset: Asset): Promise<GenPreset> {
  if (!asset.source_job_id) throw new Error("this asset wasn't generated here — nothing to reuse");
  const { data: row } = await supabase.from("jobs").select("*")
    .eq("id", asset.source_job_id).maybeSingle();
  const job = row as Job | null;
  if (!job) throw new Error("the job that made this has been deleted");
  const p = (job.payload ?? {}) as Payload;
  const meta = asset.meta ?? {};

  const prompt = str(p.prompt) ?? str(meta.prompt as string) ?? "";
  if (!prompt) throw new Error("that job carried no prompt");

  // The asset says what was made; the job kind agrees but doesn't have to be
  // one we know (v1 rows are still in here), so the asset wins.
  const kind: "image" | "video" =
    asset.kind === "video" || asset.kind === "render" ? "video" : "image";

  const ids = refIds(p);
  const found = ids.length ? await loadAssetsByIds(ids) : new Map<string, Asset>();
  const refs = ids.map((id) => found.get(id)).filter(Boolean) as Asset[];
  const frames = [str(p.start_asset_id), str(p.end_asset_id)].filter(Boolean) as string[];
  const framesFound = frames.length ? await loadAssetsByIds(frames) : new Map<string, Asset>();

  return {
    token: `${asset.id}:${Date.now()}`,
    kind,
    modelId: str(job.model_id),
    modelKey: str(p.model_key) ?? str(meta.model as string),
    mode: str(p.mode) ?? str(meta.mode as string),
    prompt,
    negative: str(p.negative),
    width: num(p.width) ?? asset.width,
    height: num(p.height) ?? asset.height,
    seed: num(p.seed) ?? num(meta.seed),
    durationMs: num(p.duration_ms) ?? asset.duration_ms,
    loras: loraStack(p),
    refs,
    start: framesFound.get(str(p.start_asset_id) ?? "") ?? null,
    end: framesFound.get(str(p.end_asset_id) ?? "") ?? null,
    label: asset.b2_key.split("/").pop() ?? asset.b2_key,
    lostRefs: ids.length - refs.length,
  };
}

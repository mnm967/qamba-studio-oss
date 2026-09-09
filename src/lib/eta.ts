// ETA estimation from job_timings: rolling-median normalized rate per model.
// Rate unit: seconds of wall time per (megapixel × frame × step). Falls back
// across (model,gpu) → model → global so estimates exist from the first
// few renders.
import { supabase } from "./supabase";

export interface TimingSample {
  model_id: string | null;
  width: number | null;
  height: number | null;
  frames: number | null;
  steps: number | null;
  cold_load: boolean;
  wall_seconds: number;
  load_seconds: number | null;
  gpu: string | null;
}

const FIXED_OVERHEAD_S = 30; // staging + decode + upload
const DEFAULT_STEPS = 20;

let samples: TimingSample[] | null = null;

export async function loadTimings(limit = 400): Promise<TimingSample[]> {
  if (samples) return samples;
  const { data, error } = await supabase
    .from("job_timings")
    .select("model_id,width,height,frames,steps,cold_load,wall_seconds,load_seconds,gpu")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  samples = (data ?? []) as TimingSample[];
  return samples;
}

export function invalidateTimings() {
  samples = null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function rateOf(t: TimingSample): number | null {
  if (!t.width || !t.height || !t.frames || !t.wall_seconds) return null;
  const mp = (t.width * t.height) / 1e6;
  const steps = t.steps ?? DEFAULT_STEPS;
  const work = mp * t.frames * steps;
  if (work <= 0) return null;
  // Exclude cold-load penalty from the rate; it is added back separately.
  const wall = t.wall_seconds - (t.cold_load ? (t.load_seconds ?? 0) : 0);
  return wall > FIXED_OVERHEAD_S ? (wall - FIXED_OVERHEAD_S) / work : null;
}

export interface EtaInput {
  modelId: string;
  width: number;
  height: number;
  frames: number;
  steps?: number;
  coldLoad?: boolean;
}

/** Seconds estimate for one generation, or null with no data at all. */
export function estimateSeconds(all: TimingSample[], j: EtaInput): number | null {
  const pools = [
    all.filter((t) => t.model_id === j.modelId).slice(0, 20),
    all.slice(0, 40),
  ];
  let rate: number | null = null;
  for (const pool of pools) {
    rate = median(pool.map(rateOf).filter((x): x is number => x != null && x > 0));
    if (rate != null) break;
  }
  if (rate == null) return null;
  const work = ((j.width * j.height) / 1e6) * j.frames * (j.steps ?? DEFAULT_STEPS);
  const cold = j.coldLoad
    ? median(all.filter((t) => t.cold_load && t.load_seconds).map((t) => t.load_seconds as number)) ?? 60
    : 0;
  return Math.round(rate * work + FIXED_OVERHEAD_S + cold);
}

/** Sum estimate for a set of renders (e.g. a storyboard's blocks). The first
 * render pays the cold load; the rest are warm. */
export function estimateBatchSeconds(all: TimingSample[], jobs: EtaInput[]): number | null {
  let total = 0;
  for (let i = 0; i < jobs.length; i++) {
    const s = estimateSeconds(all, { ...jobs[i], coldLoad: i === 0 && jobs[i].coldLoad !== false });
    if (s == null) return null;
    total += s;
  }
  return total;
}

export function fmtEta(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 90) return `~${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `~${m}m`;
  return `~${(m / 60).toFixed(1)}h`;
}

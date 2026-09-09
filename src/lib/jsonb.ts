// jsonb columns are written by the worker, by migrations, and by the director
// LLM — so a field typed `string[]` in our TS may arrive as a string, an
// object, or null. Reading one directly (`.map`, `.slice().map`) crashes the
// view for everyone. These coercions keep rendering total.

/** Anything -> T[]. Arrays pass through; null/undefined -> []. */
export function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v == null) return [];
  return [];
}

/** Anything -> string[]. Accepts an array, a comma/newline-separated string,
 * or an object (its values) — the shapes an LLM actually emits. */
export function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" || typeof x === "number").map(String);
  if (typeof v === "string") {
    return v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  }
  if (v && typeof v === "object") {
    return Object.values(v as Record<string, unknown>)
      .filter((x) => typeof x === "string" || typeof x === "number").map(String);
  }
  return [];
}

/** Anything -> number[] (waveform peaks, beat grids). */
export function asNumberList(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "number" && Number.isFinite(x)) as number[];
}

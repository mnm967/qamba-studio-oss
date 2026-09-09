// Aspect + resolution ladders — shared by the library dock (GenComposer) and
// the block retake cockpit (PromptRefsModal) so a size means the same thing
// in both places.
//
// Aspect is the shape you want; resolution is how big. They used to be one
// four-way pill with the pixels hardcoded (16:9 meant 1280×704 and nothing
// else), which is why a model that can do 1080p had no way to be asked for
// it. Now the aspect picks the ratio and the resolution picks the size.
import type { ModelCatalogRow } from "./db/types";

export const ASPECTS: { id: string; label: string; r: number }[] = [
  { id: "16:9", label: "16:9", r: 16 / 9 },
  { id: "9:16", label: "9:16", r: 9 / 16 },
  { id: "1:1", label: "1:1", r: 1 },
  { id: "4:3", label: "4:3", r: 4 / 3 },
];

/** Size ladder for models that declare no `sizes` of their own — every image
 *  model today. The number is the SQUARE-EQUIVALENT edge, so a tier holds its
 *  pixel count across aspects: 1024 means ~1MP whether you asked for 1:1 or
 *  16:9. A plain long-edge ladder would have made every wide image smaller
 *  than the model's native resolution (16:9 at "1024" is 1024×576, 0.6MP —
 *  visibly worse than the 1280×704 this replaced). 1024 ≈ SDXL/Krea native
 *  and stays the default. */
export const BASE_EDGES = [768, 1024, 1280, 1536, 2048];

/** Invariant #5: dims land on the model's `dim_step` (32 for H3). Rounding is
 *  what turns the catalog's 720 into a legal 704. */
export const snapTo = (n: number, step: number) => Math.max(step, Math.round(n / step) * step);

export interface ResOption { id: string; label: string; w: number; h: number; maxFrames?: number }

/** What the resolution picker offers for this model and aspect.
 *
 *  A model that declares `sizes` (the video ones: 720p, 1080p, with real
 *  per-aspect dims and a frame ceiling) gets exactly those — the catalog is
 *  the source of truth and it knows things a ladder can't, like 1080p capping
 *  at 81 frames. Everything else gets the long-edge ladder. */
export function resOptions(model: ModelCatalogRow | null, aspectId: string): ResOption[] {
  const step = model?.dim_step || 32;
  const aspect = ASPECTS.find((a) => a.id === aspectId) ?? ASPECTS[0];
  if (model?.sizes?.length) {
    return model.sizes.map((s) => {
      const d = s.dims?.[aspectId] ?? s.dims?.["16:9"];
      const [w, h] = d ?? [1280, 720];
      return {
        id: s.id, label: s.label,
        w: snapTo(w, step), h: snapTo(h, step),
        maxFrames: s.maxFrames,
      };
    });
  }
  const k = Math.sqrt(aspect.r);
  return BASE_EDGES.map((base) => {
    const w = snapTo(base * k, step);
    const h = snapTo(base / k, step);
    return { id: String(base), label: `${w}×${h}`, w, h };
  });
}

export const megapixels = (s: ResOption) => ((s.w * s.h) / 1e6).toFixed(1);

/** The aspect + resolution pair that comes closest to dimensions this form did
 *  not choose — a reused generation supplies pixels, and the two pills only
 *  speak in ladder entries. Sweeping every aspect (rather than deriving one
 *  from the ratio) is what makes an exact match exact: 1024×1024 is on the 1:1
 *  ladder and nowhere else. Returns the pixels it landed on so the caller can
 *  say when they aren't the ones asked for. */
export function fitSize(
  model: ModelCatalogRow | null, w: number, h: number,
): { aspectId: string; resId: string; w: number; h: number } | null {
  let best: { d: number; aspectId: string; resId: string; w: number; h: number } | null = null;
  for (const a of ASPECTS) {
    for (const s of resOptions(model, a.id)) {
      const d = Math.abs(s.w - w) + Math.abs(s.h - h);
      if (!best || d < best.d) best = { d, aspectId: a.id, resId: s.id, w: s.w, h: s.h };
    }
  }
  return best;
}

/** The size a clip-level render should ASK FOR, rather than leave to the
 *  handler's own default.
 *
 *  `handle_clip_gen` falls back to a literal `1280x720` when the payload names
 *  no size — a height that is legal on NO `dim_step` 32 model — and 720/32 is
 *  exactly 22.5, the one boundary where the two languages disagree: JS's
 *  half-up `Math.round` gives 736 and Python's ties-to-even `round` gives 704.
 *  So a chain queued with no dims came back 1280x704 between blocks rendered
 *  at 1280x736, and both the preview stage and `render.py`'s `_fit` padded the
 *  difference in as black bars — letterbox on one, pillarbox on the other.
 *
 *  The honest size is the MEDIA THIS RENDER CONTINUES: an extend opens on the
 *  last frame of that clip and a chain bridges two of them, so any other shape
 *  is a change nobody asked for. Sources are tried in order; the timeline
 *  canvas is the fallback for a lane holding only placeholders, since a still
 *  the browser registered carries no dimensions at all.
 *
 *  Returns null when nothing knows — the caller then omits the keys and gets
 *  exactly the behaviour it had before. Snapping here rather than leaving it
 *  to `resolve()` is what makes the number we send the number that renders. */
export function renderDims(
  model: ModelCatalogRow | null,
  ...sources: ({ width?: number | null; height?: number | null } | null | undefined)[]
): { w: number; h: number } | null {
  const step = model?.dim_step || 32;
  for (const s of sources) {
    const w = Number(s?.width) || 0;
    const h = Number(s?.height) || 0;
    if (w > 0 && h > 0) return { w: snapTo(w, step), h: snapTo(h, step) };
  }
  return null;
}

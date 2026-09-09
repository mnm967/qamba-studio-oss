// Landing a finished render on the timeline clip that was holding its place.
//
// Its own module because BOTH runners need it — the ComfyUI one in
// `localRender.ts` and the BYOK one in `byokRender.ts` — and a second copy is
// how one of them ends up forgetting it and leaving a placeholder on the lane
// for good, which is the exact bug this path exists to close. It was inside
// `localRender` and could not be reused from there: that module reaches
// `lib/supabase` transitively, which is a static import `node --test` cannot
// resolve.
//
// `clipAttachPatch` is the pure decision and stays in `clipAttach.ts`; this is
// only the part that touches rows.
import { clipAttachPatch } from "./clipAttach.ts";
import type { JobIO } from "./jobIO.ts";
import type { Asset } from "./db/types.ts";

/**
 * `payload.target.clip_id` is the late-bound shape the timeline's own generate
 * actions use: the job cannot know the asset id it is about to create, so it
 * names the ROW the result belongs on. The browser twin of the pod's
 * `worker/handlers/blocks.py::_attach_to_clip`.
 *
 * Best effort, deliberately: a render that has already succeeded must not be
 * failed by its bookkeeping. The lane being right and a stale flag missing is
 * a far better outcome than a good take reported as an error.
 */
export async function attachToClip(io: JobIO, target: unknown, asset: Asset | undefined) {
  const clipId = (target as { clip_id?: string } | null | undefined)?.clip_id;
  if (!clipId || !asset) return;
  try {
    const { data: rows } = await io.from("clips")
      .select("id,track_id,duration_ms,label").eq("id", clipId).limit(1);
    const clip = (rows ?? [])[0] as
      { id: string; track_id: string; duration_ms: number; label: string | null } | undefined;
    if (!clip) {
      console.warn(`[local] clip ${clipId} is gone — the render stays in the library`);
      return;
    }
    const patch = clipAttachPatch(clip.duration_ms, asset.id, asset.duration_ms);
    await io.from("clips").update(patch).eq("id", clipId);
    // The flattened master was built against the placeholder.
    const { data: tracks } = await io.from("tracks")
      .select("timeline_id").eq("id", clip.track_id).limit(1);
    const tlId = (tracks ?? [])[0]?.timeline_id;
    if (tlId) await io.from("timelines").update({ render_stale: true }).eq("id", tlId);
    // Lazily, and for the module's own reason above: the hook that owns the
    // query cache reaches Supabase. It is a nudge so the lane repaints on this
    // tick rather than on the socket's — losing it costs a moment, not a fact.
    const { invalidateTables } = await import("../hooks/useLiveQuery");
    invalidateTables(["clips", "timelines"]);
  } catch (e) {
    console.warn("[local] could not attach the render to its clip", e);
  }
}

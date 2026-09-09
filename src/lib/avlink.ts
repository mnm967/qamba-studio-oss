// Detaching a block's audio: which lane it lands on, and what the audio clip
// is made of.
//
// The store does the writing; the decisions live here because they are the
// part with branches, and the part a test can reach without a database.
import type { Asset, Clip, Track } from "./db/types";

/** Does `clip` occupy any of [from, to)? Touching ends don't overlap — two
 *  blocks back to back are exactly what an audio lane should be able to hold. */
export const overlaps = (clip: Pick<Clip, "t_start_ms" | "duration_ms">, from: number, to: number) =>
  clip.t_start_ms < to && clip.t_start_ms + clip.duration_ms > from;

/** The lane a detached clip should go to: the first unlocked audio lane whose
 *  window is free, in lane order. `null` means every lane is busy there and
 *  the caller should add one.
 *
 *  Predictable beats clever. Detaching a whole episode this way fills one lane
 *  in order (blocks don't overlap each other), a project whose A1 already
 *  holds a master track skips to A2 on its own, and anything the rule gets
 *  wrong is one drag to fix — an audio clip moves between lanes like any
 *  other. */
export function pickAudioLane(
  tracks: Track[],
  clips: Pick<Clip, "track_id" | "t_start_ms" | "duration_ms">[],
  window: { t_start_ms: number; duration_ms: number }
): Track | null {
  const from = window.t_start_ms;
  const to = window.t_start_ms + window.duration_ms;
  return tracks
    .filter((t) => t.kind === "audio" && !t.locked)
    .sort((a, b) => a.idx - b.idx)
    .find((t) => !clips.some((c) => c.track_id === t.id && overlaps(c, from, to))) ?? null;
}

/** The audio clip a detach creates: the same media over the same window.
 *
 *  Nothing is extracted or re-encoded — an <audio> element decodes an mp4's
 *  audio stream, and the renderer hands each audio clip to ffmpeg as its own
 *  input either way — so the clip is a second view of one asset, and its
 *  geometry has to match the picture's exactly or the pair starts out of sync.
 *  `out_ms` falls back to the asset's full length: a clip that has never been
 *  trimmed carries null there, and a null out on the audio half would make a
 *  later trim compute its ceiling from nothing. */
export function detachedClipFrom(clip: Clip, laneId: string, asset?: Asset | null) {
  return {
    track_id: laneId,
    asset_id: clip.asset_id,
    t_start_ms: clip.t_start_ms,
    duration_ms: clip.duration_ms,
    in_ms: clip.in_ms ?? 0,
    out_ms: clip.out_ms ?? asset?.duration_ms ?? null,
    block_id: clip.block_id ?? undefined,
    label: `${clip.label ?? "clip"} · audio`,
    linked_clip_id: clip.id,
  };
}

/** Can this clip's audio be detached at all? A clip that already has a linked
 *  half would otherwise get a second one, and both would play. */
export const canDetach = (clip: Clip | undefined, track: Track | undefined) =>
  !!clip && !!track && track.kind === "video" && !clip.linked_clip_id && !track.locked;

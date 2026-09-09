// LANDING A FINISHED RENDER ON THE CLIP THAT WAS HOLDING ITS PLACE — the pure
// half of the browser twin of `worker/handlers/blocks.py::_attach_to_clip`.
//
// The timeline's generate actions (extend, chain, add-after) park an extracted
// STILL on the lane the moment you press the button, so the edit is real while
// the GPU works, and name that clip in `payload.target.clip_id`. Whoever
// finishes the render has to repoint it. The pod does; the desktop runner did
// not, so a local extend rendered into the library and left the placeholder on
// the lane for good — which reads as "the extension never arrived", with a
// held picture where the shot should be.
//
// Split out because the DB half is untestable without a database and the RULE
// is where the damage is: growing a clip silently overlaps whatever is next on
// the lane, and leaving it longer than its own media plays black past the end
// and parks the preview on "buffering…".

export interface ClipAttachPatch {
  asset_id: string;
  in_ms: number;
  out_ms: number | null;
  duration_ms?: number;
}

/**
 * What to write onto the clip.
 *
 * `duration_ms` only ever SHRINKS, and only when the render came back shorter
 * than the slot reserved for it. Every frame grid here rounds UP (invariant
 * #5), so that is the rare case — but a clip longer than its own media is
 * exactly the failure this repoint exists to fix, so it is handled rather than
 * assumed away. Growing it instead would silently overlap the next clip.
 */
export function clipAttachPatch(
  heldMs: number,
  assetId: string,
  renderedMs: number | null | undefined
): ClipAttachPatch {
  const dur = Math.max(0, Math.round(renderedMs ?? 0));
  const held = Math.max(0, Math.round(heldMs));
  const patch: ClipAttachPatch = { asset_id: assetId, in_ms: 0, out_ms: dur || null };
  if (dur && held && dur < held) patch.duration_ms = dur;
  return patch;
}

// COPY, PASTE AND DUPLICATE on the timeline — the pure half.
//
// Split out for the reason `avlink.ts` and `blockSync.ts` are: the store does
// the writing, and the decisions are the part with branches and the part a
// test can reach without a database. Three of them are silent when wrong:
//
//   * a copy that keeps `linked_clip_id` verbatim makes THREE clips claim one
//     partner. `unlinkAudio`, `reattachAudio` and `removeClip` all follow that
//     id, so the copy's delete takes the original's sound away.
//   * a copy that keeps `transition_in` carries a dissolve — or worse, a
//     GENERATED transition rendered between two specific shots — onto a join
//     between two different ones.
//   * a copy dropped where something already sits overlaps it. On a video lane
//     the player picks one of them per frame; nothing errors, a shot is just
//     missing from the cut.
import { overlaps } from "./avlink.ts";
import type { Clip, Track } from "./db/types";

/** How far a placement will search before giving up. A lane holds tens of
 *  clips, so this is a runaway guard rather than a limit anyone meets. */
const MAX_PROBES = 500;

/**
 * The first instant at or after `wantMs` where `durationMs` fits on EVERY one
 * of these lanes.
 *
 * A linked pair needs a window free on the picture's lane AND the sound's at
 * the same time — their geometry is mirrored, so they cannot be placed
 * independently.
 *
 * Sliding right rather than rippling is deliberate. A ripple would move clips
 * the user did not touch, and on a lane holding a LINKED clip it would slide
 * dialogue off the shot it was detached from — the same reason
 * `autoAlignImpl` refuses to pack such a lane. "As close to where you asked as
 * it can get" moves nobody and destroys nothing.
 */
export function firstFreeAt(
  lanes: Pick<Clip, "t_start_ms" | "duration_ms">[][],
  wantMs: number,
  durationMs: number,
): number {
  let at = Math.max(0, Math.round(wantMs));
  const dur = Math.max(1, Math.round(durationMs));
  for (let i = 0; i < MAX_PROBES; i++) {
    let pushed = false;
    for (const lane of lanes) {
      for (const c of lane) {
        if (overlaps(c, at, at + dur)) {
          at = Math.max(at, c.t_start_ms + c.duration_ms);
          pushed = true;
        }
      }
    }
    if (!pushed) return at;
  }
  return at;
}

/** " copy", " copy 2", " copy 3"… rather than "copy copy copy". */
export function copyLabel(label: string | null | undefined): string {
  const base = label?.trim() || "clip";
  const m = /^(.*?) copy(?: (\d+))?$/.exec(base);
  if (!m) return `${base} copy`;
  return `${m[1]} copy ${m[2] ? Number(m[2]) + 1 : 2}`;
}

/**
 * The first free copy name for `base`, given the names already in use.
 *
 * `copyLabel` bumps ONE label, which is what ⌘D on a clip has — the thing it
 * is copying. Dropping the same block onto the lane a third time has no
 * previous copy to bump, only a set of names already on the cut, so this
 * folds `copyLabel` over them until one is free. Same spelling either way:
 * two ways of naming a copy is how a lane ends up reading "Block 8 copy"
 * beside "Block 8 (2)".
 *
 * Case-insensitive, because the names are read rather than parsed.
 */
export function nextCopyLabel(base: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const t of taken) { const s = t?.trim().toLowerCase(); if (s) used.add(s); }
  let name = copyLabel(base);
  for (let i = 0; i < MAX_PROBES && used.has(name.toLowerCase()); i++) name = copyLabel(name);
  return name;
}

/** The row a copy is inserted as. `t_start_ms` and `track_id` are the
 *  caller's; everything else describes what this clip IS. */
export interface ClipSeed {
  track_id: string;
  asset_id: string;
  block_id?: string;
  /** The block take this clip deliberately plays, if it had one. */
  take_id?: string;
  t_start_ms: number;
  duration_ms: number;
  in_ms: number;
  out_ms: number | null;
  ops: Clip["ops"];
  gain_db: number;
  label?: string;
  audio_detached: boolean;
  audio_fx: Clip["audio_fx"];
  post: Clip["post"];
}

/**
 * What a copy of `clip` is made of.
 *
 * Two fields are deliberately NOT carried:
 *
 *   * `linked_clip_id`. The copies link to EACH OTHER or to nothing — see the
 *     header. The store sets it after both rows exist, because neither id is
 *     known until then.
 *   * `transition_in`. It describes the join with whatever precedes the clip,
 *     and a copy has a different neighbour. A `generated` transition is worse
 *     than merely decorative there: it names an asset rendered between two
 *     specific shots, so the copy would play a dissolve built for a cut that
 *     is not this one.
 *
 * Everything that describes the clip itself travels: the media and its window,
 * the ops, the level, the effect rack and the finishing chain. A copy that
 * looked or sounded different from the thing it was copied from would be the
 * feature not working.
 */
export function seedFrom(
  clip: Clip,
  at: { trackId: string; tStartMs: number; label?: string },
): ClipSeed {
  return {
    track_id: at.trackId,
    asset_id: clip.asset_id,
    block_id: clip.block_id ?? undefined,
    // The pin travels with the media it names. ⌘D on a copy that is playing
    // its own take is how a THIRD copy of that take gets onto the lane, and a
    // copy that dropped the pin would look identical until the next sync
    // quietly moved it to the block's take instead.
    take_id: clip.take_id ?? undefined,
    t_start_ms: Math.max(0, Math.round(at.tStartMs)),
    duration_ms: clip.duration_ms,
    in_ms: clip.in_ms ?? 0,
    out_ms: clip.out_ms ?? null,
    ops: clip.ops ?? [],
    gain_db: clip.gain_db ?? 0,
    label: at.label ?? copyLabel(clip.label),
    audio_detached: clip.audio_detached ?? false,
    audio_fx: clip.audio_fx ?? [],
    post: clip.post ?? null,
  };
}

/** What the clipboard holds: a clip, and the linked half if it had one. */
export interface ClipboardEntry {
  clip: Clip;
  /** The A/V partner. Copied WITH it, or a pasted `audio_detached` picture is
   *  a silent clip whose sound was left behind — silent in both senses. */
  partner: Clip | null;
  /** The kind of lane the clip came off, so a paste can refuse a lane that
   *  cannot play it before it writes a row. */
  kind: "video" | "audio";
}

/**
 * Which of a linked pair is the PICTURE, whichever half was right-clicked.
 *
 * A detached pair is a video clip carrying `audio_detached` and an audio clip
 * carrying the sound, and the two menus reach it from opposite ends. Rebuilding
 * it the wrong way round pastes a SOUND clip as the main half with a picture
 * linked back to it and never silenced — so the copy plays its audio twice,
 * once from each lane, which is a comb filter rather than a louder take.
 *
 * `audio_detached` is the marker rather than the lane kind, because the lane a
 * clip sits on is a fact about the timeline and this is a fact about the clip:
 * an audio clip dragged onto a video lane by hand is still not a picture.
 * An unlinked clip is its own main half and has no partner, which is the
 * ordinary case for everything on an audio lane.
 */
export function pairOf(
  clip: Clip,
  partner: Clip | null,
  kind: "video" | "audio",
): ClipboardEntry {
  if (!partner) return { clip, partner: null, kind };
  const main = clip.audio_detached ? clip : (partner.audio_detached ? partner : clip);
  const other = main.id === clip.id ? partner : clip;
  // The kind is the MAIN half's lane. When the pair had to be flipped, the
  // half we were handed was the sound and the main one is a picture by
  // definition — `audio_detached` only ever sits on a video clip.
  return { clip: main, partner: other, kind: main.id === clip.id ? kind : "video" };
}

export interface PasteTarget {
  main: Track;
  /** Where the linked half goes. Null when there is no partner to place. */
  partner: Track | null;
}

/**
 * Which lanes a paste lands on, or the sentence explaining why it cannot.
 *
 * The MAIN half goes to the lane the user aimed at — the clip they
 * right-clicked, or the selected clip's lane for ⌘V — because a paste with no
 * stated target has to invent one, and inventing one is how a shot ends up on
 * a lane nobody was looking at. It refuses a kind mismatch rather than
 * correcting it: a video clip on an audio lane is a row the mixer feeds to
 * ffmpeg as an audio input and the player renders in an `<audio>` element.
 */
export function pasteTarget(
  entry: ClipboardEntry,
  tracks: Track[],
  preferredTrackId: string | null,
): PasteTarget | { error: string } {
  const want = entry.kind;
  const pick = tracks.find((t) => t.id === preferredTrackId);
  if (pick && pick.kind !== want) {
    return { error: `That's ${want === "video" ? "a picture" : "an audio"} clip — `
      + `paste it on ${want === "video" ? "a video" : "an audio"} lane.` };
  }
  if (pick?.locked) return { error: `${pick.name ?? "That lane"} is locked.` };
  const main = pick
    ?? tracks.filter((t) => t.kind === want && !t.locked).sort((a, b) => a.idx - b.idx)[0];
  if (!main) return { error: `There is no unlocked ${want} lane to paste onto.` };

  if (!entry.partner) return { main, partner: null };
  // The partner's own lane first — a detached pair pasted back onto the lanes
  // it came from is what someone means by "paste it again".
  const pk = entry.partner.track_id;
  const partner = tracks.find((t) => t.id === pk && t.kind === "audio" && !t.locked)
    ?? tracks.filter((t) => t.kind === "audio" && !t.locked && t.id !== main.id)
      .sort((a, b) => a.idx - b.idx)[0]
    ?? null;
  if (!partner) {
    return { error: "This clip's audio was detached onto a lane that is gone or locked — "
      + "add an unlocked audio lane, or re-attach its audio first." };
  }
  return { main, partner };
}

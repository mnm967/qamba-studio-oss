/**
 * Which characters still need a voice, and what a job that makes one carries.
 *
 * WHY THIS EXISTS IN THE BROWSER AT ALL. Voice references used to be queued
 * in exactly one place — `llm.plan_storyboard`, unconditionally, the moment a
 * plan finished — so the only way to get one was to let the planner spend it
 * for you, and the only way to get a DIFFERENT one was to re-plan. That is
 * fine when every character's voice is a guess anyway and wrong as soon as
 * you have an opinion: a cast voice is repeated into every block of the
 * episode, and the point at which you know what someone should sound like is
 * while you are reading their identity line, not two steps later.
 *
 * So the cast & world step queues them itself, one character at a time or all
 * at once, and `plan_storyboard` is told not to (`brief.voice_refs`).
 *
 * PYTHON TWIN: `llm.speakers_needing_voice_refs` + `llm.pick_tts_voice`. The
 * two are pinned against each other by `voiceRefs.test.ts`, which parses
 * `worker/llm.py` — a preset table that drifts is two characters sharing one
 * voice, which is the exact collision `taken` exists to prevent and is
 * invisible until you play two clips back to back.
 */
import { LOCAL_ENGINES } from "./speechProviders.ts";
import type { BibleEntry, Beat } from "./db/types.ts";

/** Every engine a character's timbre clip can be recorded on — the plan-time
 *  set plus `openai`, which is the per-clip fallback. Derived, so a third
 *  local engine widens it without a second list to remember. */
export type TtsProviderName = (typeof LOCAL_ENGINES)[number] | "elevenlabs" | "openai";

const KNOWN: readonly TtsProviderName[] = [...LOCAL_ENGINES, "elevenlabs", "openai"];

/**
 * OpenAI's preset voices and the timbre words that select each one.
 *
 * ORDER IS THE FALLBACK ORDER, so `alloy` is last and matches nothing: it is
 * what a character with no written voice gets, and what everyone gets once
 * the other five are taken.
 */
export const TTS_VOICES: readonly (readonly [string, readonly string[]])[] = [
  ["onyx", ["deep", "low", "gravel", "bass", "booming", "rumbl"]],
  ["echo", ["crisp", "clipped", "sharp", "cool", "precise"]],
  ["fable", ["warm", "storyteller", "lilt", "british", "gentle"]],
  ["nova", ["bright", "young", "light", "energetic", "quick"]],
  ["shimmer", ["soft", "breathy", "airy", "smoky", "husky"]],
  ["alloy", []],
];

/** The nearest preset to a written voice descriptor, skipping any already
 *  handed out. Twin of `llm.pick_tts_voice`. */
export function pickTtsVoice(descriptor: string | null | undefined,
                             taken: ReadonlySet<string>): string {
  const d = (descriptor ?? "").toLowerCase();
  const ranked = [
    ...TTS_VOICES.filter(([, keys]) => keys.some((k) => d.includes(k))).map(([v]) => v),
  ];
  for (const [v] of TTS_VOICES) if (!ranked.includes(v)) ranked.push(v);
  return ranked.find((v) => !taken.has(v)) ?? ranked[0];
}

/** A character the episode gives lines to. */
export interface SpeakingRole {
  entry: BibleEntry;
  /** their first spoken line, which is what the clip says. Empty when the
   *  storyboard names them as a speaker without giving them words yet. */
  line: string;
  /** the writer's voice prose (`doc.voice`), which picks the preset and rides
   *  along as the delivery note */
  descriptor: string;
  /** already has a timbre clip on file */
  have: boolean;
}

const docStr = (e: BibleEntry, k: string): string => {
  const v = (e.doc ?? {})[k];
  return typeof v === "string" ? v.trim() : "";
};

/** The bare name, without the ` — outfit` suffix a variant carries. */
export const baseName = (n: string): string => n.split(" — ")[0].trim();

/**
 * Every character with a line in this storyboard, in the order they first
 * speak, flagged with whether they already have a clip.
 *
 * MATCHED ON THE SPEAKER'S NAME as well as `speaker_id`, and both are tried:
 * the planner writes a name into `dialogue[].speaker` and an id is only
 * present once something has resolved one, so a board that has never been
 * through the director tools has names and nothing else.
 *
 * A BASE NAME IS ONLY A HANDLE WHEN ONE ENTRY OWNS IT. An outfit variant is
 * filed as "Rei — flight suit" while the writer says "Rei", so the base has
 * to resolve — but a cast of "Rei", "Guide Rei" and "Knight Rei" has one base
 * with three owners, and picking any of them is a clip attached to the wrong
 * character. Ambiguity is a MISS, the rule `match_brief_name` already
 * follows: the speaker is skipped and the character keeps saying they have no
 * voice, which is visible, rather than getting somebody else's.
 */
export function speakingRoles(
  bible: readonly BibleEntry[], beats: readonly Beat[],
): SpeakingRole[] {
  const chars = bible.filter((b) => b.kind === "character");
  const byFull = new Map(chars.map((c) => [c.name.toLowerCase(), c] as const));
  const owners = new Map<string, number>();
  for (const c of chars) {
    const b = baseName(c.name).toLowerCase();
    owners.set(b, (owners.get(b) ?? 0) + 1);
  }
  const byBase = new Map<string, BibleEntry>();
  for (const c of chars) {
    const b = baseName(c.name).toLowerCase();
    if (owners.get(b) === 1) byBase.set(b, c);
  }

  const firstLine = new Map<string, string>();
  const order: string[] = [];
  for (const b of beats) {
    for (const d of b.dialogue ?? []) {
      const nm = (d.speaker ?? "").trim().toLowerCase();
      const hit = (d.speaker_id ? chars.find((c) => c.id === d.speaker_id) : undefined)
        ?? (nm ? byFull.get(nm) ?? byBase.get(nm) : undefined);
      if (!hit) continue;
      if (!firstLine.has(hit.id)) {
        order.push(hit.id);
        firstLine.set(hit.id, (d.line ?? "").trim());
      }
    }
  }
  return order.map((id) => {
    const entry = chars.find((c) => c.id === id)!;
    return {
      entry,
      line: firstLine.get(id) ?? "",
      descriptor: docStr(entry, "voice"),
      have: Boolean(entry.voice_ref_asset_id),
    };
  });
}

export function voiceRefPayload(
  role: SpeakingRole, opts: { provider?: string | null; voice?: string | null },
): Record<string, unknown> {
  const name = baseName(role.entry.name);
  return {
    // The clip says the character's OWN first line where they have one: a
    // timbre reference read from the script sounds like the show, and a
    // generic sentence sounds like a voice demo.
    text: (role.line || `This is how ${name} sounds when they speak.`).slice(0, 220),
    ...(opts.voice ? { voice: opts.voice } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.provider === "elevenlabs" && opts.voice ? { el_voice_id: opts.voice } : {}),
    // WHOSE VOICE, as distinct from where the clip lands (`bible_entry_id`).
    // Both name the same entry here and they are read by different halves of
    // the handler: without this one, `_el_voice` and `_breeze_voice` resolve
    // nothing, the named provider's branch is skipped, and the job falls
    // through to the OpenAI chain — a preset where a cast voice was asked
    // for, logged and otherwise silent. On Breeze it also earns the good
    // fallback: an uncast character gets a voice DESIGNED from the delivery
    // note below rather than a stock read.
    speaker_entry_id: role.entry.id,
    label: `voice ref · ${name.slice(0, 28)}`,
    // Empty rather than absent would be a delivery note of "", which reads as
    // a direction on the engines that take one.
    //
    // THE CAP IS 400, AND 80 TRUNCATED TWO THIRDS OF EVERY CAST. On
    // ElevenLabs this field is keyword-matched onto ONE v3 audio tag, where
    // 80 characters is plenty and where the cap came from; on Breeze and Qwen
    // it is the natural-language instruction a voice is DESIGNED from, and
    // the tail is where the writer puts the part that makes it a particular
    // person. Measured on the live bible: 63 of the 92 characters carrying a
    // `doc.voice` are over 80 characters (max 384, mean 92), so Rhea Dorne's
    // "...a clipped frontier-station accent." reached the engine as "...a
    // clipped frontier-station " — the accent cut off mid-phrase, silently.
    ...(role.descriptor ? { emotion: role.descriptor.slice(0, 400) } : {}),
    bible_entry_id: role.entry.id,
    // WHICH KEY RUST MAY PUT IN THE CHILD'S ENVIRONMENT, for a job this
    // machine claims. Named rather than "every key here" — the convention
    // `AudioVoiceStudio` states — but the list is TWO, and the second is the
    // one that is easy to leave out: `handle_tts` falls through to the OpenAI
    // chain whenever the named engine resolves nothing, which right after a
    // plan is the ordinary case (a character is cast only if the engine was
    // reachable at plan time). Withholding it turns a documented fallback
    // into a failed job on a machine that has the key. Rust forwards only a
    // key that EXISTS, so naming one there is none of is free.
    byok_providers: [...new Set([...(opts.provider ? [opts.provider] : []), "openai"])],
  };
}

/**
 * Assign every character a preset, without collisions.
 *
 * Seeded from the presets ALREADY IN USE in this project, not from an empty
 * set — a returning lead and a new supporting character otherwise get handed
 * the same voice, which is the collision `llm.py`'s own `taken` was built to
 * prevent and which nothing on screen would show you.
 */
export function assignVoices(
  roles: readonly SpeakingRole[], used: Iterable<string> = [],
): Map<string, string> {
  const taken = new Set(used);
  const out = new Map<string, string>();
  for (const r of roles) {
    const v = pickTtsVoice(r.descriptor, taken);
    taken.add(v);
    out.set(r.entry.id, v);
  }
  return out;
}


/**
 * The engine a SINGLE character's clip should be recorded on, from what the
 * entry already says, or null for "let the worker decide".
 *
 * Reads an explicit `voice_provider` set on the character sheet, or infers
 * from existing casting: a Breeze voice is a designed clip, an `el_voice_id`
 * is an ElevenLabs cast, and an uncast character gets no `provider` at all,
 * which is what `plan_storyboard` sends and what `_pick_provider` answers.
 */
export function providerForEntry(doc: Record<string, unknown> | null | undefined):
  TtsProviderName | null {
  const d = doc ?? {};
  const prov = typeof d.voice_provider === "string" ? d.voice_provider.toLowerCase() : null;
  if (prov && (KNOWN as readonly string[]).includes(prov)) return prov as TtsProviderName;
  // NO STORED PROVIDER: infer it from the clip the casting left behind. Every
  // LOCAL engine keeps its designed clip at `doc.<engine>_voice`, so this
  // walks them rather than naming Breeze — a character cast on the second one
  // read as UNCAST here, and the sheet then opened on Breeze and offered to
  // re-record a voice that already existed on another engine.
  for (const e of LOCAL_ENGINES) {
    if ((d[`${e}_voice`] as { asset_id?: string } | undefined)?.asset_id) return e;
  }
  if (typeof d.el_voice_id === "string" && d.el_voice_id) return "elevenlabs";
  return null;
}

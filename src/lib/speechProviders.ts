/**
 * Which speech engine a catalogue row actually speaks through, and where a
 * character's voice for it is kept.
 *
 * THE BUG THIS ENDS. `model_catalog.provider` is the VENDOR column for a
 * hosted row and the LOCATION column for a local one — every engine the studio
 * hosts reads `local`, which is not a value `handlers/tts.PROVIDERS` contains.
 * A one-off ternary in the studio panel mapped the Fish row and nothing else,
 * so picking "Breeze TTS 2 (local)" queued `provider: "local"`, which
 * `_pick_provider` logs as unknown and falls through to OPENAI — a line
 * rendered in a stock voice by a different engine, on the pod as well as the
 * desktop, with nothing on screen to say so.
 *
 * A table rather than a condition, because the failure is silent and the next
 * local engine would repeat it. Pinned in both directions by
 * `speechProviders.test.ts`: every id is a row `gen_model_catalog.py` defines
 * and every value is one `handlers/tts.py` accepts.
 */
import type { BibleEntry, ModelCatalogRow } from "./db/types.ts";

/** Catalogue id → the `handle_tts` provider it runs on. */
export const PROVIDER_OF: Record<string, string> = {
  "breeze-tts-2": "breeze",
  "qwen3-tts": "qwen",
  "fish-s2-local": "fish-local",
};

/**
 * The engines whose voice is a designed CLIP on this machine, and the prefix
 * each stamps on a voice id. `worker/voice_engines.py` is the source — the
 * spelling is decided there and this is the browser's copy, pinned against it.
 */
export const LOCAL_ENGINES = ["breeze", "qwen"] as const;

/**
 * What a plan may be CAST on — every local engine, plus ElevenLabs.
 *
 * DERIVED from `LOCAL_ENGINES` rather than written out, so a third engine
 * added there widens every picker that stores one of these without anybody
 * remembering to. It deliberately excludes `openai`: `dialogue_synth.
 * resolve_provider` answers `unknown dialogue provider` for anything that is
 * neither, and the OpenAI chain is the per-clip fallback rather than something
 * an episode is cast on.
 */
export type DialogueProvider = (typeof LOCAL_ENGINES)[number] | "elevenlabs";

export const providerOf = (m: Pick<ModelCatalogRow, "id" | "provider">): string =>
  PROVIDER_OF[m.id] ?? m.provider;

/**
 * The voice this character speaks in on `provider`, or null.
 *
 * TWO ENGINES KEEP IT IN DIFFERENT PLACES, and neither is a fallback for the
 * other: ElevenLabs casts a stock `voice_id` onto `doc.el_voice_id`, while
 * Breeze DESIGNS a clip from the writer's voice prose and refers to it as
 * `breeze:<asset id>` — the whole voice is that recording. Reading one where
 * the other is meant is how a cast member gets auditioned in a stranger's
 * voice, which is exactly what "auditioning a line any other way is not an
 * audition of the take you will get" is trying to prevent.
 *
 * `doc.voice_provider` is what `dialogue_synth._voice_of_doc` writes when it
 * casts, so this is that function's reading half. Qwen3-TTS is the second
 * local engine and keeps its clip the same way (`doc.qwen_voice`) — which is
 * why this reads the key off the provider name rather than naming Breeze's.
 */
export function castVoiceOf(
  entry: Pick<BibleEntry, "doc">, provider: string,
): string | null {
  const doc = (entry.doc ?? {}) as Record<string, unknown> & {
    el_voice_id?: string;
  };
  if ((LOCAL_ENGINES as readonly string[]).includes(provider)) {
    // `doc.<engine>_voice.asset_id`, the shape `cast_local_voice` writes. One
    // key per engine rather than a shared one, because a character cast on
    // both keeps both clips and `doc.voice_provider` decides which speaks.
    const a = (doc[`${provider}_voice`] as { asset_id?: string } | undefined)?.asset_id;
    return a ? `${provider}:${a}` : null;
  }
  if (provider === "elevenlabs") return doc.el_voice_id || null;
  // Every other engine speaks in a stock voice or a clone; a character has no
  // cast voice there, and listing them would offer a pick that changes nothing.
  return null;
}

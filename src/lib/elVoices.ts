// The ElevenLabs casting table, mirrored from worker/dialogue_synth.py
// VOICE_TABLE — keep the two in step (ids are ElevenLabs premade voices).
// The worker owns casting logic; this mirror exists so the bible modal can
// NAME a cast voice and offer a recast without a round trip.
export interface ElVoice {
  id: string;
  name: string;
  gender: "f" | "m";
  hint: string;
}

export const EL_VOICES: ElVoice[] = [
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", gender: "f", hint: "low, clipped, precise, professional" },
  { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily", gender: "f", hint: "velvet, smooth, mature, British" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", gender: "f", hint: "cold, clinical, crisp, courteous" },
  { id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura", gender: "f", hint: "rapid, energetic, young, bright" },
  { id: "bIHbv24MWmeRgasZH58o", name: "Will", gender: "m", hint: "soft, relaxed, quiet — young" },
  { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie", gender: "m", hint: "deep, confident — young" },
  { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam", gender: "m", hint: "bright, quick, energetic — young" },
  { id: "nPczCjzI2devNBz1zQrb", name: "Brian", gender: "m", hint: "deep, gravel, slow, resonant" },
  { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", gender: "m", hint: "steady, broadcast, neutral" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", gender: "m", hint: "warm, storyteller, older" },
  { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica", gender: "f", hint: "playful, warm, light, soft" },
];

export const elVoiceName = (id?: string | null): string | null =>
  EL_VOICES.find((v) => v.id === id)?.name ?? null;

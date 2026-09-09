// What the final render is ENCODED as — container, video codec, quality, audio.
//
// Every one of these was hardcoded in worker/handlers/render.py until now:
// libx264 / yuv420p / crf 18 / veryfast, aac 192k 48kHz stereo, always .mp4.
// Fine as a default and useless as the only option — a cut going to an editor
// wants ProRes, a cut going on the web wants VP9, and a 90-second master at
// crf 18 is not the same file as one at crf 28.
//
// THE TABLE IS THE CONTRACT AND IT IS TWINNED with worker/render_output.py.
// This side decides what is OFFERED and whether a combination is legal; the
// worker builds the ffmpeg arguments. Only the worker encodes, so there is no
// second implementation of the encode to drift — but a format this file offers
// and the worker cannot build is a render that dies after the GPU time is
// spent, so `renderOutput.test.ts` parses the Python and fails if the two
// tables disagree.
//
// EVERY CODEC HERE WAS CHECKED AGAINST THE POD'S OWN ffmpeg (4.4.2) on
// 2026-08-23 — `ffmpeg -encoders` plus an NVENC smoke render. Nothing is
// offered on the strength of it usually being available. AV1 is absent for
// exactly that reason: this build has neither libsvtav1 nor av1_nvenc.
//
// Dependency-free, same rule as postChain.ts — db/types.ts imports from here.

export type VideoFormatId = "h264" | "h265" | "prores" | "vp9";
export type AudioCodecId = "aac" | "opus" | "pcm_s24le" | "none";

export interface VideoFormatDef {
  id: VideoFormatId;
  label: string;
  /** File extension AND the container ffmpeg infers from it. */
  ext: "mp4" | "mov" | "webm";
  contentType: string;
  /** Software encoder. */
  encoder: string;
  /** NVENC equivalent, where one exists on this pod. Absent = no hardware
   *  path, and the Hardware switch is hidden rather than ignored. */
  hwEncoder?: string;
  /** How quality is expressed. `crf` is a number that gets LOWER as quality
   *  rises; `profile` is ProRes's enum, which does not work that way at all —
   *  conflating them is how a "quality 3" slider ends up meaning 422 LT. */
  quality: "crf" | "profile";
  qualityMin: number;
  qualityMax: number;
  qualityDefault: number;
  /** Audio codecs this container will actually mux. */
  audio: AudioCodecId[];
  hint: string;
}

/** Ordered as the picker shows them: delivery first, then handoff. */
export const VIDEO_FORMATS: VideoFormatDef[] = [
  {
    id: "h264", label: "H.264", ext: "mp4", contentType: "video/mp4",
    encoder: "libx264", hwEncoder: "h264_nvenc",
    quality: "crf", qualityMin: 14, qualityMax: 32, qualityDefault: 18,
    audio: ["aac", "none"],
    hint: "Plays everywhere. The default, and the right answer unless you have "
        + "a reason — every browser, phone and NLE reads it.",
  },
  {
    id: "h265", label: "H.265 / HEVC", ext: "mp4", contentType: "video/mp4",
    encoder: "libx265", hwEncoder: "hevc_nvenc",
    quality: "crf", qualityMin: 18, qualityMax: 36, qualityDefault: 22,
    audio: ["aac", "none"],
    hint: "Roughly half the size of H.264 at the same look. Playback support "
        + "is good but not universal — Safari and modern NLEs yes, older "
        + "Windows players no. Note its CRF scale is not H.264's: 22 here is "
        + "about 18 there.",
  },
  {
    id: "prores", label: "ProRes 422", ext: "mov", contentType: "video/quicktime",
    encoder: "prores_ks",
    quality: "profile", qualityMin: 0, qualityMax: 5, qualityDefault: 3,
    audio: ["pcm_s24le", "aac", "none"],
    hint: "Editorial handoff — intra-frame, effectively lossless at HQ, and "
        + "what a colourist or an NLE wants. Very large: budget roughly 1GB "
        + "per minute at 1080p HQ.",
  },
  {
    id: "vp9", label: "VP9", ext: "webm", contentType: "video/webm",
    encoder: "libvpx-vp9",
    quality: "crf", qualityMin: 24, qualityMax: 45, qualityDefault: 31,
    audio: ["opus", "none"],
    hint: "Web delivery where you control the player. Smaller than H.264, and "
        + "slow to encode — there is no hardware encoder for it.",
  },
];

export const VIDEO_FORMAT = Object.fromEntries(
  VIDEO_FORMATS.map((f) => [f.id, f]),
) as Record<VideoFormatId, VideoFormatDef>;

/** ProRes `profile` is an enum, not a scale — named so the slider can say what
 *  it is picking rather than showing a bare 0-5. */
export const PRORES_PROFILES: Record<number, string> = {
  0: "Proxy", 1: "LT", 2: "422", 3: "422 HQ", 4: "4444", 5: "4444 XQ",
};

export interface AudioCodecDef {
  id: AudioCodecId;
  label: string;
  /** Bitrate is meaningless for PCM (it is uncompressed) and for none. */
  bitrates?: number[];
  bitrateDefault?: number;
  hint: string;
}

export const AUDIO_CODECS: AudioCodecDef[] = [
  { id: "aac", label: "AAC", bitrates: [128, 192, 256, 320], bitrateDefault: 192,
    hint: "The usual choice for a delivery file." },
  { id: "opus", label: "Opus", bitrates: [96, 128, 192, 256], bitrateDefault: 128,
    hint: "Better than AAC at the same bitrate, and what WebM carries." },
  { id: "pcm_s24le", label: "PCM 24-bit",
    hint: "Uncompressed, for editorial handoff. Large, and only in a .mov." },
  { id: "none", label: "No audio",
    hint: "Strips the track entirely — a picture-only master." },
];

export const AUDIO_CODEC = Object.fromEntries(
  AUDIO_CODECS.map((a) => [a.id, a]),
) as Record<AudioCodecId, AudioCodecDef>;

export const SAMPLE_RATES = [44100, 48000];

export interface RenderOutput {
  format: VideoFormatId;
  /** CRF for the crf formats, ProRes profile index for ProRes. One field
   *  because it is one control; `VideoFormatDef.quality` says how to read it. */
  quality: number;
  /** Use the NVENC encoder where the format has one. Ignored (and the control
   *  hidden) where it does not. */
  hardware: boolean;
  audio: AudioCodecId;
  audioBitrate: number;
  sampleRate: number;
  /** Delivery resolution as the SHORT EDGE in pixels, or null for the
   *  timeline's own frame.
   *
   *  The short edge and not the height, because that is the one reading that
   *  works both ways up: 1080p is ?x1080 on a landscape cut and 1080x? on a
   *  vertical one, and both are what "1080p" means to the person asking. The
   *  timeline's aspect is preserved either way — this resizes the frame, it
   *  never re-frames it, so a 1280x704 cut at 1080p delivers 1964x1080 rather
   *  than a letterboxed 1920x1080. The modal shows the computed size, so an
   *  aspect that is not 16:9 is visible rather than surprising. */
  resolution: number | null;
  /** Output frame rate, or null for the timeline's own. */
  fps: number | null;
}

export const RENDER_OUTPUT_DEFAULT: RenderOutput = {
  format: "h264",
  quality: 18,
  // Software by default even though NVENC is measurably faster: x264 at crf 18
  // is the file this studio has always produced, and a master that silently
  // changed encoder would change what every past render is compared against.
  hardware: false,
  audio: "aac",
  audioBitrate: 192,
  sampleRate: 48000,
  resolution: null,
  fps: null,
};

/** Short-edge targets, with the label people actually say. 540p earns its
 *  place as the review/proxy size; 4K is 2160 because that is what everyone
 *  outside a DCI house means by it (DCI 4K is 4096 wide and is not on offer). */
export const RESOLUTIONS: { value: number; label: string; title: string }[] = [
  { value: 540, label: "540p", title: "540 on the short edge — a review or proxy copy" },
  { value: 720, label: "720p", title: "720 on the short edge" },
  { value: 1080, label: "1080p", title: "1080 on the short edge" },
  { value: 1440, label: "1440p", title: "1440 on the short edge (QHD)" },
  { value: 2160, label: "4K", title: "2160 on the short edge (UHD)" },
];

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Read whatever is on the row into a usable spec.
 *
 *  Forgiving where the value is merely out of range (clamp) and CORRECTIVE
 *  where the combination is illegal (an audio codec the container cannot mux
 *  falls back to that container's first). The alternative — passing it through
 *  — is a render that dies in ffmpeg after every clip has already been
 *  encoded, which on a long cut is half an hour of GPU time to learn that
 *  webm will not carry AAC. */
export function normalizeOutput(v: unknown): RenderOutput {
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Partial<RenderOutput>;
  const fmt = VIDEO_FORMAT[o.format as VideoFormatId] ? (o.format as VideoFormatId)
                                                      : RENDER_OUTPUT_DEFAULT.format;
  const def = VIDEO_FORMAT[fmt];
  const quality = clamp(
    Number.isFinite(o.quality) ? Math.round(Number(o.quality)) : def.qualityDefault,
    def.qualityMin, def.qualityMax);
  const audio: AudioCodecId = def.audio.includes(o.audio as AudioCodecId)
    ? (o.audio as AudioCodecId) : def.audio[0];
  const acodec = AUDIO_CODEC[audio];
  const rates = acodec.bitrates;
  const audioBitrate = rates
    ? (rates.includes(Number(o.audioBitrate)) ? Number(o.audioBitrate) : acodec.bitrateDefault!)
    : 0;
  const sampleRate = SAMPLE_RATES.includes(Number(o.sampleRate))
    ? Number(o.sampleRate) : RENDER_OUTPUT_DEFAULT.sampleRate;
  const resolution = RESOLUTIONS.some((r) => r.value === Number(o.resolution))
    ? Number(o.resolution) : null;
  const fps = Number.isFinite(o.fps as number) && Number(o.fps) > 0
    ? clamp(Math.round(Number(o.fps)), 1, 120) : null;
  return {
    format: fmt, quality,
    hardware: def.hwEncoder ? o.hardware === true : false,
    audio, audioBitrate, sampleRate, resolution, fps,
  };
}

/** The encoder that will actually run — what the summary line should name, so
 *  "Hardware" is never a switch whose effect you have to infer. */
export function encoderOf(o: RenderOutput): string {
  const def = VIDEO_FORMAT[o.format];
  return o.hardware && def.hwEncoder ? def.hwEncoder : def.encoder;
}

/** "H.264 · CRF 18 · AAC 192k · .mp4" — the closed-state summary. */
export function describeOutput(o: RenderOutput): string {
  const def = VIDEO_FORMAT[o.format];
  const q = def.quality === "profile"
    ? `ProRes ${PRORES_PROFILES[o.quality] ?? o.quality}`
    : `CRF ${o.quality}`;
  const a = o.audio === "none" ? "no audio"
    : AUDIO_CODEC[o.audio].bitrates ? `${AUDIO_CODEC[o.audio].label} ${o.audioBitrate}k`
    : AUDIO_CODEC[o.audio].label;
  const parts = [def.label, q, a];
  if (o.hardware && def.hwEncoder) parts.push("hardware");
  if (o.resolution) parts.push(RESOLUTIONS.find((r) => r.value === o.resolution)!.label);
  if (o.fps) parts.push(`${o.fps}fps`);
  return `${parts.join(" · ")} · .${def.ext}`;
}

/** The delivered frame size, given the timeline's.
 *
 *  Even dimensions, because yuv420p cannot represent an odd one and ffmpeg
 *  FAILS the encode rather than rounding for you — on the last step of a long
 *  render. */
export function outputSize(o: RenderOutput, width: number, height: number): { w: number; h: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  if (!o.resolution) return { w: even(width), h: even(height) };
  const f = o.resolution / Math.min(width, height);
  return { w: even(width * f), h: even(height * f) };
}

/** Is this target bigger than the cut actually is? The one question a named
 *  resolution invites you not to ask — "4K" reads like a quality setting and
 *  is really a resampling instruction. */
export function isUpscale(o: RenderOutput, width: number, height: number): boolean {
  return !!o.resolution && o.resolution > Math.min(width, height);
}

/** Warnings worth showing BEFORE a render that costs GPU minutes. Measured or
 *  structural only — no taste. */
export function outputWarnings(o: RenderOutput, width: number, height: number): string[] {
  const def = VIDEO_FORMAT[o.format];
  const out: string[] = [];
  const { w, h } = outputSize(o, width, height);
  if (isUpscale(o, width, height)) {
    out.push(`This cut is ${width}x${height}. Delivering ${w}x${h} resamples the `
           + `finished frame and adds no detail — the Upscale post pass is the `
           + `one that restores it.`);
  }
  if (o.format === "prores") {
    const mbPerMin = Math.round((w * h) / (1920 * 1080) * 880);
    out.push(`ProRes is large: roughly ${mbPerMin}MB per minute at ${w}x${h}.`);
  }
  if (o.format === "vp9") {
    out.push("VP9 has no hardware path here, so this encode is several times "
           + "slower than H.264.");
  }
  if (o.hardware && def.hwEncoder) {
    out.push("NVENC is much faster and gives up some quality per bit. For a "
           + "master, prefer software; for a review copy, this is the one to use.");
  }
  return out;
}

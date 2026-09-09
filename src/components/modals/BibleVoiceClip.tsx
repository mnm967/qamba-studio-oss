// A character's voice-timbre clip, on their bible sheet.
//
// WHAT IT REPLACED: one line of grey text reading "no timbre clip yet — one is
// made with the first block". That was never quite true (the clip is made at
// PLAN time, not at render time) and it stopped being true at all when the
// plan became a choice — so the one screen that is entirely about a character
// reported a missing voice as something that would sort itself out, and
// offered nothing.
//
// THE THREE WAYS TO GET ONE, which is why this is a row rather than a button:
// record it from the character's own description, upload a recording you
// already have, or leave it and let the block invent a voice per shot. The
// third is what happens today and is the one worth naming, because it is
// invisible until you play two blocks back to back.
import React from "react";
import { AlertTriangle, Check, ChevronDown, Loader2, Mic, Upload } from "lucide-react";
import Dropdown from "../ui/Dropdown";
import { assetUrl, registerAsset } from "../../lib/db/assets";
import { saveEntry } from "../../lib/db/director";
import { enqueueJob } from "../../lib/db/jobs";
import { EL_VOICES, elVoiceName } from "../../lib/elVoices";
import { probedUploadMeta } from "../../lib/mediaProbe";
import { uploadMedia } from "../../lib/upload";
import { baseName, pickTtsVoice, providerForEntry, TTS_VOICES, voiceRefPayload } from "../../lib/voiceRefs";
import { LOCAL_ENGINES, type DialogueProvider } from "../../lib/speechProviders";
import type { Asset, BibleEntry, JobLane } from "../../lib/db/types";

/** Every engine this sheet can record a character's timbre clip on.
 *
 *  `DialogueProvider` is the plan-time set (local engines + ElevenLabs);
 *  `openai` is here and not there because it is the per-clip fallback rather
 *  than something an episode is cast on — `resolve_provider` refuses it. */
export type TtsProvider = DialogueProvider | "openai";

const TTS_PROVIDERS: readonly string[] = [...LOCAL_ENGINES, "elevenlabs", "openai"];

const ENGINE_NAMES: Record<string, string> = {
  breeze: "Breeze TTS 2",
  qwen: "Qwen3-TTS 1.7B",
  elevenlabs: "ElevenLabs v3",
  openai: "OpenAI",
};

/**
 * The pill's colour per engine — the AT-A-GLANCE signal on a closed picker,
 * where the name is small and the tint is what you read.
 *
 * A TABLE, because it was four nested ternaries ending in an `else`: a second
 * local engine fell through them and wore OpenAI's green, so a Qwen-cast
 * character was indistinguishable from a stock-voice one on the one control
 * that is meant to tell them apart. Violet is deliberately clear of the other
 * three rather than a second blue — two local engines that look alike are the
 * same failure one step milder.
 */
const ENGINE_TINT: Record<string, { fg: string; rgb: string }> = {
  breeze: { fg: "#8fc2ff", rgb: "90, 162, 255" },
  qwen: { fg: "#b79cff", rgb: "183, 156, 255" },
  elevenlabs: { fg: "#e8c268", rgb: "232, 194, 104" },
  openai: { fg: "#6fd08c", rgb: "111, 208, 140" },
};

const tintOf = (p: string) => ENGINE_TINT[p] ?? ENGINE_TINT.openai;

/** A stored `doc.voice_provider` read back, or null when it names nothing this
 *  sheet can record on. One parser rather than three copies of the same
 *  disjunction, which is what let a second local engine be missed by two of
 *  them and silently fall back to Breeze. */
const asTtsProvider = (v: unknown): TtsProvider | null => {
  const p = typeof v === "string" ? v.toLowerCase() : "";
  return TTS_PROVIDERS.includes(p) ? (p as TtsProvider) : null;
};

/** Engines whose voice is a DESIGNED CLIP kept at `doc.<engine>_voice`. */
const isLocalEngine = (p: string): boolean =>
  (LOCAL_ENGINES as readonly string[]).includes(p);

export type VoiceJobInfo = {
  id: string;
  kind: string;
  status: string;
  progress: number | null;
  progress_note: string | null;
  error_msg: string | null;
};

/**
 * One engine in the picker.
 *
 * A COMPONENT RATHER THAN A FOURTH COPY of forty lines of near-identical JSX.
 * The three hand-written rows had already drifted — each carried its own chip
 * colour and its own subtitle by hand — and a second local engine would have
 * made that four places to keep a shared layout in step.
 */
function ProviderRow({ id, provider, name, chip, chipColor, sub, onPick }: {
  id: TtsProvider;
  provider: TtsProvider;
  name: string;
  chip: string;
  chipColor: string;
  sub: string;
  onPick: (p: TtsProvider) => void;
}) {
  const on = provider === id;
  return (
    <button type="button" className={"ws-menu-row" + (on ? " on" : "")}
            onClick={() => onPick(id)}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center",
                       justifyContent: "space-between" }}>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{name}</span>
          <span className="chip"
                style={{ fontSize: 9.5, padding: "1px 5px", color: chipColor }}>
            {chip}
          </span>
        </span>
        <span style={{ display: "block", fontSize: 10.5, color: "#5e6678",
                       marginTop: 2 }}>
          {sub}
        </span>
      </span>
      {on && <Check size={12} style={{ color: "#5aa2ff", flexShrink: 0 }} />}
    </button>
  );
}

export default function BibleVoiceClip({
  entry, asset, voiceJob, onSaveDoc, onChanged,
}: {
  entry: BibleEntry;
  /** the clip `voice_ref_asset_id` names, when it has been loaded */
  asset: Asset | null;
  /** active in-flight or recent voice generation job for this character */
  voiceJob?: VoiceJobInfo | null;
  /** notify the parent sheet of document updates so form state stays in sync */
  onSaveDoc?: (key: string, val: unknown) => Promise<void>;
  onChanged: () => void;
}) {
  const [busy, setBusy] = React.useState<null | "record" | "upload">(null);
  const [pct, setPct] = React.useState<number | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [localQueued, setLocalQueued] = React.useState(false);
  const file = React.useRef<HTMLInputElement>(null);
  const name = baseName(entry.name);

  const doc = (entry.doc ?? {}) as Record<string, unknown>;

  // Initial provider: explicit voice_provider > inferred providerForEntry > "breeze" default
  const [provider, setProvider] = React.useState<TtsProvider>(() =>
    asTtsProvider(doc.voice_provider)
      ?? (providerForEntry(doc) as TtsProvider)
      ?? "breeze");

  const [elVoiceId, setElVoiceId] = React.useState<string>(() =>
    (typeof doc.el_voice_id === "string" && doc.el_voice_id) || EL_VOICES[0].id,
  );

  const [openaiVoice, setOpenaiVoice] = React.useState<string>(() =>
    (typeof doc.openai_voice === "string" && doc.openai_voice)
      || pickTtsVoice(String(doc.voice ?? ""), new Set()),
  );

  // Derive job execution states
  const isRunning = voiceJob?.status === "running";
  const isError = voiceJob?.status === "error";
  const isQueued = !isError && !isRunning && (voiceJob?.status === "queued" || localQueued);
  const isInFlight = isQueued || isRunning;

  // Clear local queue when a new asset arrives
  const prevAssetIdRef = React.useRef<string | null>(asset?.id ?? null);
  React.useEffect(() => {
    if (asset?.id && asset.id !== prevAssetIdRef.current) {
      prevAssetIdRef.current = asset.id;
      setLocalQueued(false);
      setErr(null);
    }
  }, [asset?.id]);

  // Clear local queue if backend job fails
  React.useEffect(() => {
    if (voiceJob?.status === "error") {
      setLocalQueued(false);
    }
  }, [voiceJob?.status]);

  // Safety timer for local queue state
  React.useEffect(() => {
    if (!localQueued) return;
    if (voiceJob?.status === "queued" || voiceJob?.status === "running") {
      setLocalQueued(false);
      return;
    }
    const t = setTimeout(() => {
      setLocalQueued(false);
    }, 25000);
    return () => clearTimeout(t);
  }, [localQueued, voiceJob?.status]);

  // Sync if entry prop doc changes from outside
  React.useEffect(() => {
    const prov = asTtsProvider(doc.voice_provider);
    if (prov) setProvider(prov);
    if (typeof doc.el_voice_id === "string" && doc.el_voice_id) {
      setElVoiceId(doc.el_voice_id);
    }
    if (typeof doc.openai_voice === "string" && doc.openai_voice) {
      setOpenaiVoice(doc.openai_voice);
    }
  }, [entry.doc]);

  const persistDoc = async (key: string, val: unknown) => {
    if (onSaveDoc) {
      await onSaveDoc(key, val);
    } else {
      await saveEntry(entry.id, { doc: { ...(entry.doc ?? {}), [key]: val } });
    }
  };

  const selectProvider = async (p: TtsProvider) => {
    setProvider(p);
    await persistDoc("voice_provider", p);
    if (p === "elevenlabs" && !doc.el_voice_id) {
      await persistDoc("el_voice_id", elVoiceId);
    }
  };

  const selectElVoice = async (id: string) => {
    setElVoiceId(id);
    await persistDoc("el_voice_id", id);
  };

  const selectOpenaiVoice = async (v: string) => {
    setOpenaiVoice(v);
    await persistDoc("openai_voice", v);
  };

  const record = async (chosenProvider = provider, chosenVoice?: string) => {
    setBusy("record");
    setErr(null);
    setLocalQueued(true);
    try {
      const activeVoice = chosenVoice ?? (
        chosenProvider === "elevenlabs" ? elVoiceId
          : chosenProvider === "openai" ? openaiVoice
          : null
      );

      // THE SAME ROUTING THE PLAN USES. With a speech key or a Breeze of your
      // own this records HERE; `cpu` is the studio's queue, and hardcoding it
      // would leave a desktop with a key waiting on a pod nobody started.
      const { planLanesHere } = await import("../../lib/desktopPlanner");
      const lanes = await planLanesHere(null, entry.project_id)
        .catch(() => ({} as Record<string, string>));

      // RE-RECORDING A LOCAL ENGINE CLEARS ITS DESIGNED CLIP, so it designs a
      // fresh voice rather than cloning the old one — `design_voice` caches
      // forever by (engine, name, description), so a stale clip left in place
      // makes the re-record return exactly what it replaced. Keyed on the
      // engine BEING recorded: `breeze_voice` and `qwen_voice` are separate
      // keys and a character may hold both.
      if (isLocalEngine(chosenProvider) && doc[`${chosenProvider}_voice`]) {
        await persistDoc(`${chosenProvider}_voice`, null);
      }
      await persistDoc("voice_provider", chosenProvider);
      if (chosenProvider === "elevenlabs" && activeVoice) {
        await persistDoc("el_voice_id", activeVoice);
      } else if (chosenProvider === "openai" && activeVoice) {
        await persistDoc("openai_voice", activeVoice);
      }

      await enqueueJob({
        kind: "tts", lane: (lanes.tts ?? "cpu") as JobLane,
        priority: 20, project_id: entry.project_id,
        payload: voiceRefPayload(
          { entry, line: "", descriptor: String(doc.voice ?? ""), have: false },
          { provider: chosenProvider, voice: activeVoice }),
      });
      onChanged();
    } catch (e) {
      setLocalQueued(false);
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const upload = async (f: File) => {
    setBusy("upload");
    setErr(null);
    setPct(0);
    try {
      const key = `audio/voice/${entry.project_id}/${Date.now()}_`
                + `${f.name.replace(/[^\w.-]+/g, "_")}`;
      await uploadMedia(f, key, setPct);
      const a = await registerAsset({
        b2_key: key, kind: "audio", project_id: entry.project_id,
        content_type: f.type || "audio/mpeg", bytes: f.size,
        origin: "uploaded", tags: ["voiceover"],
        // The same meta a recorded clip carries, so anything reading the
        // anchor cannot tell where it came from — `kind_hint` is what the
        // library groups voices by.
        meta: { kind_hint: "voice", bible_entry_id: entry.id,
                speaker_entry_id: entry.id, original_name: f.name },
        // Measured in the browser rather than left null: `duration_ms` is
        // written by the pod's ingest, and on a machine with no pod a null
        // stands indefinitely.
        ...(await probedUploadMeta(f)),
      });
      // The pin is what makes it the character's anchor — the same write
      // `handle_tts` makes when it records one.
      await saveEntry(entry.id, { voice_ref_asset_id: a.id });
      // Waveform peaks and an exact probe, exactly as the recorded path does.
      await enqueueJob({ kind: "asset_ingest", lane: "cpu", priority: 60,
                         project_id: entry.project_id, payload: { asset_id: a.id } })
        .catch(() => { /* peaks are cosmetic; the clip is already the anchor */ });
      setLocalQueued(false);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      setPct(null);
    }
  };

  const engineName = ENGINE_NAMES[provider] ?? provider;

  const voiceDetail = provider === "elevenlabs" ? (elVoiceName(elVoiceId) ?? elVoiceId)
    : provider === "openai" ? openaiVoice
    : null;

  return (
    <div className="ws-bs-row mid">
      <span className="ws-flabel">Voice clip</span>
      <div className="ws-bs-ctl" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {asset ? (
            <audio
              controls
              preload="none"
              src={assetUrl(asset) ?? undefined}
              style={{
                height: 32,
                flex: "1 1 200px",
                minWidth: 180,
                maxWidth: 320,
                borderRadius: 16,
                outline: "none",
                opacity: isInFlight ? 0.55 : 1,
                filter: isInFlight ? "grayscale(0.5)" : "none",
                transition: "opacity .2s, filter .2s",
              }}
              title="The Ref2VA voice-timbre reference clip"
            />
          ) : (
            <div
              style={{
                height: 32,
                flex: "1 1 200px",
                minWidth: 180,
                maxWidth: 320,
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 12px",
                borderRadius: 16,
                boxSizing: "border-box",
                background: isInFlight
                  ? isRunning
                    ? "rgba(90, 162, 255, 0.08)"
                    : "rgba(232, 194, 104, 0.08)"
                  : "rgba(255, 255, 255, 0.03)",
                border: isInFlight
                  ? isRunning
                    ? "1px solid rgba(90, 162, 255, 0.3)"
                    : "1px solid rgba(232, 194, 104, 0.35)"
                  : "1px dashed rgba(255, 255, 255, 0.12)",
                color: isInFlight
                  ? isRunning
                    ? "#8fc2ff"
                    : "#e8c268"
                  : "#727d90",
              }}
            >
              {isInFlight ? (
                <>
                  <Loader2
                    size={13}
                    className="ns-spin"
                    style={{ color: isRunning ? "#5aa2ff" : "#e8c268", flexShrink: 0 }}
                  />
                  <span
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {isRunning ? "synthesizing timbre…" : "timbre clip queued…"}
                  </span>
                </>
              ) : (
                <>
                  <Mic size={12} style={{ opacity: 0.45, flexShrink: 0 }} />
                  <span className="mono" style={{ fontSize: 10.5, letterSpacing: "0.02em" }}>
                    no timbre clip yet
                  </span>
                </>
              )}
            </div>
          )}

          {/* TTS Engine & Voice Picker */}
          <Dropdown
            width={320}
            align="left"
            trigger={({ toggle, open }) => (
              <button
                type="button"
                className={"ws-microbtn" + (open ? " on" : "")}
                disabled={!!busy || isInFlight}
                onClick={toggle}
                title={`Voice engine: ${engineName}${voiceDetail ? ` · ${voiceDetail}` : ""}. Click to switch engine or voice.`}
                style={{
                  height: 32,
                  padding: "0 10px",
                  gap: 6,
                  borderRadius: 16,
                  border: open
                    ? `1px solid rgba(${tintOf(provider).rgb}, 0.6)`
                    : "1px solid rgba(255, 255, 255, 0.1)",
                  background: open
                    ? "rgba(255, 255, 255, 0.08)"
                    : "rgba(255, 255, 255, 0.04)",
                  cursor: isInFlight ? "not-allowed" : "pointer",
                }}
              >
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 800,
                    letterSpacing: "0.04em",
                    padding: "1px 5px",
                    borderRadius: 6,
                    background: `rgba(${tintOf(provider).rgb}, 0.16)`,
                    color: tintOf(provider).fg,
                    border: `1px solid rgba(${tintOf(provider).rgb}, 0.3)`,
                  }}
                >
                  TTS
                </span>
                <span style={{ color: "#eaeef6", fontWeight: 600, fontSize: 11.5 }}>
                  {engineName}
                </span>
                {voiceDetail && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 10,
                      color: "#9aa4b6",
                      maxWidth: 85,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    · {voiceDetail}
                  </span>
                )}
                <ChevronDown
                  size={12}
                  style={{
                    opacity: 0.65,
                    transform: open ? "rotate(180deg)" : "none",
                    transition: "transform .15s",
                    marginLeft: 1,
                  }}
                />
              </button>
            )}
          >
            {(closeMenu) => (
              <div style={{ padding: "4px 0" }}>
                <div
                  className="ws-menu-label"
                  style={{
                    padding: "6px 12px 4px",
                    display: "flex",
                    justifyContent: "space-between",
                  }}
                >
                  <span>record voice with engine</span>
                  <span className="mono" style={{ fontSize: 9, opacity: 0.55 }}>
                    tts picker
                  </span>
                </div>

                <ProviderRow id="breeze" provider={provider} name={"Breeze TTS 2"}
                             chip={"free · AI designed"} chipColor={ENGINE_TINT.breeze.fg}
                             sub={"Designs the voice from the written description, and directs each line"}
                             onPick={(x) => void selectProvider(x)} />
                <ProviderRow id="qwen" provider={provider} name={"Qwen3-TTS 1.7B"}
                             chip={"free · Apache 2.0"} chipColor={ENGINE_TINT.qwen.fg}
                             sub={"Designs the voice from the description. Apache 2.0; cannot direct delivery"}
                             onPick={(x) => void selectProvider(x)} />

                <ProviderRow id="elevenlabs" provider={provider} name={"ElevenLabs v3"}
                             chip={"curated cast"} chipColor={ENGINE_TINT.elevenlabs.fg}
                             sub={elVoiceName(elVoiceId) ? `Cast voice: ${elVoiceName(elVoiceId)}` : "Expressive library voices"}
                             onPick={(x) => void selectProvider(x)} />

                {/* ElevenLabs Voice List */}
                {provider === "elevenlabs" && (
                  <div
                    style={{
                      padding: "7px 12px 9px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 5,
                      background: "rgba(232,194,104,.04)",
                      borderTop: "1px solid rgba(255,255,255,.05)",
                      borderBottom: "1px solid rgba(255,255,255,.05)",
                    }}
                  >
                    <span className="mono" style={{ fontSize: 9.5, color: "#e8c268" }}>
                      Select cast voice:
                    </span>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 4,
                        maxHeight: 110,
                        overflowY: "auto",
                      }}
                    >
                      {EL_VOICES.map((v) => (
                        <button
                          key={v.id}
                          type="button"
                          className={
                            "ws-microbtn" + (v.id === elVoiceId ? " accent" : "")
                          }
                          style={{ height: 22, padding: "0 7px", fontSize: 10 }}
                          title={`${v.name} (${
                            v.gender === "f" ? "female" : "male"
                          }) — ${v.hint}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void selectElVoice(v.id);
                          }}
                        >
                          {v.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <ProviderRow id="openai" provider={provider} name={"OpenAI"}
                             chip={"preset"} chipColor={ENGINE_TINT.openai.fg}
                             sub={`Preset voice: ${openaiVoice}`}
                             onPick={(x) => void selectProvider(x)} />

                {/* OpenAI Voice List */}
                {provider === "openai" && (
                  <div
                    style={{
                      padding: "7px 12px 9px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 5,
                      background: "rgba(111,208,140,.04)",
                      borderTop: "1px solid rgba(255,255,255,.05)",
                      borderBottom: "1px solid rgba(255,255,255,.05)",
                    }}
                  >
                    <span className="mono" style={{ fontSize: 9.5, color: "#6fd08c" }}>
                      Select preset:
                    </span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {TTS_VOICES.map(([v, tags]) => (
                        <button
                          key={v}
                          type="button"
                          className={
                            "ws-microbtn" + (v === openaiVoice ? " accent" : "")
                          }
                          style={{ height: 22, padding: "0 7px", fontSize: 10 }}
                          title={tags.length ? tags.join(", ") : "standard read"}
                          onClick={(e) => {
                            e.stopPropagation();
                            void selectOpenaiVoice(v);
                          }}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Quick record action inside menu */}
                <div
                  style={{
                    padding: "8px 10px 4px",
                    borderTop: "1px solid rgba(255,255,255,.07)",
                    marginTop: 4,
                  }}
                >
                  <button
                    type="button"
                    className="ws-microbtn accent"
                    disabled={!!busy || isInFlight}
                    style={{ width: "100%", height: 28, justifyContent: "center" }}
                    onClick={() => {
                      closeMenu();
                      void record();
                    }}
                  >
                    {busy === "record" || isInFlight ? (
                      <Loader2 size={11} className="ns-spin" />
                    ) : (
                      <Mic size={11} />
                    )}
                    {asset
                      ? `Re-record with ${engineName}`
                      : `Record with ${engineName}`}
                  </button>
                </div>
              </div>
            )}
          </Dropdown>

          {/* Record / Re-record Button */}
          <button
            type="button"
            className="ws-microbtn"
            disabled={!!busy || isInFlight}
            title={
              isQueued
                ? "Recording job is waiting in queue..."
                : isRunning
                ? "Synthesizing voice timbre clip..."
                : asset
                ? `Record ${name} again using ${engineName}`
                : `Record a clip from ${name}'s written voice using ${engineName}`
            }
            onClick={() => void record()}
            style={{
              height: 32,
              padding: "0 12px",
              borderRadius: 16,
              gap: 6,
              fontSize: 11.5,
              fontWeight: 600,
              transition: "all .15s ease",
              cursor: isInFlight ? "wait" : "pointer",
              ...(isQueued
                ? {
                    background: "rgba(232, 194, 104, 0.14)",
                    borderColor: "rgba(232, 194, 104, 0.4)",
                    color: "#e8c268",
                    opacity: 1,
                  }
                : isRunning
                ? {
                    background: "rgba(90, 162, 255, 0.16)",
                    borderColor: "rgba(90, 162, 255, 0.5)",
                    color: "#8fc2ff",
                    opacity: 1,
                  }
                : {
                    background: "rgba(90, 162, 255, 0.12)",
                    borderColor: "rgba(90, 162, 255, 0.35)",
                    color: "#8fc2ff",
                  }),
            }}
          >
            {busy === "record" || isInFlight ? (
              <Loader2
                size={13}
                className="ns-spin"
                style={{
                  color: isQueued ? "#e8c268" : "#8fc2ff",
                }}
              />
            ) : (
              <Mic size={13} />
            )}
            <span>
              {isQueued
                ? "In queue…"
                : isRunning
                ? "Synthesizing…"
                : asset
                ? "Re-record"
                : "Record"}
            </span>
          </button>

          {/* Upload Button */}
          <button
            type="button"
            className="ws-microbtn"
            disabled={!!busy || isInFlight}
            title="Use a recording of your own — any audio file"
            onClick={() => file.current?.click()}
            style={{
              height: 32,
              padding: "0 12px",
              borderRadius: 16,
              gap: 6,
              fontSize: 11.5,
              cursor: isInFlight ? "not-allowed" : "pointer",
            }}
          >
            {busy === "upload" ? (
              <Loader2 size={13} className="ns-spin" />
            ) : (
              <Upload size={13} />
            )}
            <span>{pct != null ? `${Math.round(pct)}%` : "Upload"}</span>
          </button>
          <input
            ref={file}
            type="file"
            accept="audio/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void upload(f);
            }}
          />
        </div>

        {/* In-Queue & Synthesizing Live Status Card */}
        {isInFlight && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "7px 12px",
              borderRadius: 10,
              background: isRunning
                ? "linear-gradient(90deg, rgba(90, 162, 255, 0.12) 0%, rgba(90, 162, 255, 0.04) 100%)"
                : "linear-gradient(90deg, rgba(232, 194, 104, 0.12) 0%, rgba(232, 194, 104, 0.04) 100%)",
              border: `1px solid ${
                isRunning ? "rgba(90, 162, 255, 0.3)" : "rgba(232, 194, 104, 0.35)"
              }`,
              boxShadow: "0 2px 8px rgba(0, 0, 0, 0.25)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0, flex: 1 }}>
              <Loader2
                size={14}
                className="ns-spin"
                style={{
                  color: isRunning ? "#5aa2ff" : "#e8c268",
                  flexShrink: 0,
                }}
              />
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                  <span
                    style={{
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: isRunning ? "#8fc2ff" : "#e8c268",
                    }}
                  >
                    {isRunning ? "Synthesizing voice timbre" : "Voice synthesis queued"}
                  </span>
                  <span
                    className="mono"
                    style={{
                      fontSize: 9.5,
                      color: "#9aa4b6",
                      background: "rgba(255, 255, 255, 0.06)",
                      padding: "1px 5px",
                      borderRadius: 4,
                    }}
                  >
                    {engineName}
                    {voiceDetail ? ` · ${voiceDetail}` : ""}
                  </span>
                </div>
                <span style={{ fontSize: 10.5, color: "#8a94a6", marginTop: 1 }}>
                  {isRunning
                    ? (voiceJob?.progress_note ?? "Worker is generating voice timbre reference…")
                    : "Waiting in queue for speech worker — will automatically land on this sheet"}
                </span>
              </div>
            </div>

            {isRunning && voiceJob?.progress != null ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                <div
                  style={{
                    width: 90,
                    height: 5,
                    background: "rgba(255, 255, 255, 0.1)",
                    borderRadius: 3,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.max(8, Math.round(voiceJob.progress * 100))}%`,
                      height: "100%",
                      background: "linear-gradient(90deg, #5aa2ff, #8fc2ff)",
                      transition: "width 0.25s ease-out",
                    }}
                  />
                </div>
                <span
                  className="mono"
                  style={{ fontSize: 10.5, color: "#8fc2ff", fontWeight: 700 }}
                >
                  {Math.round(voiceJob.progress * 100)}%
                </span>
              </div>
            ) : (
              <span
                className="mono"
                style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  color: isRunning ? "#8fc2ff" : "#e8c268",
                  letterSpacing: "0.05em",
                  padding: "2px 7px",
                  borderRadius: 6,
                  background: isRunning
                    ? "rgba(90, 162, 255, 0.1)"
                    : "rgba(232, 194, 104, 0.1)",
                  border: `1px solid ${
                    isRunning
                      ? "rgba(90, 162, 255, 0.25)"
                      : "rgba(232, 194, 104, 0.25)"
                  }`,
                }}
              >
                {isRunning ? "PROCESSING" : "QUEUED"}
              </span>
            )}
          </div>
        )}

        {/* Error Card */}
        {(isError || err) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              padding: "7px 12px",
              borderRadius: 10,
              background: "rgba(255, 90, 90, 0.1)",
              border: "1px solid rgba(255, 90, 90, 0.3)",
              color: "#ff8080",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <AlertTriangle size={14} style={{ flexShrink: 0 }} />
              <span
                style={{
                  fontSize: 11.5,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {voiceJob?.error_msg || err || "Voice synthesis encountered an error"}
              </span>
            </div>
            <button
              type="button"
              className="ws-microbtn danger"
              style={{ height: 24, padding: "0 9px", fontSize: 10.5, borderRadius: 12 }}
              onClick={() => void record()}
            >
              Retry
            </button>
          </div>
        )}

        {/* Helper Note with Status Dot */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 7,
            fontSize: 11,
            lineHeight: 1.45,
            color: "#7e889b",
            marginTop: 1,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              marginTop: 5,
              flexShrink: 0,
              background: asset ? "#5aa2ff" : isInFlight ? "#e8c268" : "#4e5666",
              boxShadow: asset
                ? "0 0 6px rgba(90, 162, 255, 0.55)"
                : isInFlight
                ? "0 0 6px rgba(232, 194, 104, 0.55)"
                : "none",
            }}
          />
          <span>
            {asset ? (
              <>
                Every block this character is in is handed this clip as their voice timbre (
                <span style={{ color: "#eaeef6", fontWeight: 600 }}>{engineName}</span>
                {voiceDetail ? <span style={{ color: "#9aa4b6" }}> · {voiceDetail}</span> : null}
                ).
              </>
            ) : (
              <>
                Without a clip, each block invents a voice per shot. Record one with{" "}
                <span style={{ color: "#eaeef6", fontWeight: 600 }}>{engineName}</span> or upload an audio file.
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

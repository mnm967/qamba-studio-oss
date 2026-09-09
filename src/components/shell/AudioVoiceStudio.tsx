// The Audio & Voice studio rail: three generators (voice, sound effects,
// music) plus the project's audio library, in one narrow column.
//
// Everything here queues a REAL job kind and every model on offer is a row
// from `model_catalog`. That is worth stating because the panel this replaced
// did neither: it listed Suno, Udio, Fish Speech, Cartesia and half a dozen
// other models the studio has never been able to run, and its SFX and Music
// buttons both enqueued a `tts` job with no `text` — which the worker rejects
// on its first line, so every click of either button produced a failed job and
// nothing else. The voice model picker was decoration too: `handle_tts` reads
// `voice`, never `model`.
//
// The layout rule that keeps a 350px rail readable: ONE composer card per
// mode — model line, the text that matters, a single row of pills, one
// button — and then the results. The chip walls (eight SFX presets, seven
// genres, four sample lines), the two "open the library" banners and the
// three-card timeline-lane footer are gone; they repeated what the tab bar and
// the result rows already say, and together they were most of the scroll.
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Check, ChevronDown, Copy, Film, FolderOpen, Loader2, Mic, Music, Play, Plus,
  RotateCcw, Search, Square, Trash2, Upload, UserPlus, Video, Volume2, Wand2, X,
} from "lucide-react";
import Dropdown from "../ui/Dropdown";
import { enqueueJob, USER_PRIORITY } from "../../lib/db/jobs";
import { loadAssets, registerAsset } from "../../lib/db/assets";
import { probedUploadMeta } from "../../lib/mediaProbe";
import {
  createVoiceClone, deleteVoiceClone, loadVoiceClones,
} from "../../lib/db/voices";
import { uploadMedia } from "../../lib/upload";
import { mediaUrl } from "../../lib/supabase";
import {
  describeDirectorError, enhancePrompt,
} from "../../lib/director";
import { invalidateTables } from "../../hooks/useLiveQuery";
import { modelKeyOf } from "../../lib/projectSettings";
import { isLocalId, tierOf } from "../../lib/localModels";
import { plannerInstalled } from "../../lib/desktopPlanner";
import { isDesktopReady, markDesktopRows } from "../../lib/desktopRows";
import { castVoiceOf, providerOf, LOCAL_ENGINES } from "../../lib/speechProviders";
import { breezeStatus, type BreezeStatus } from "../../lib/breezeLocal";
import { qwenStatus, type QwenStatus } from "../../lib/qwenLocal";
import { useByok } from "../../hooks/useByok";
import TieredModelMenu, { TierIcon } from "../ui/TieredModelMenu";
import { isByokRow, markSpeechRows } from "../../lib/byokCatalog";
import { useLocalEngine } from "../../hooks/useLocalEngine";
import {
  DEFAULT_NEGATIVE, clampSeconds, clipCoverage, durationNote, framesNeeded,
  v2aDefaults, v2aLabel, v2aPayload,
} from "../../lib/mmaudio";
import AssetPickerModal from "../modals/AssetPickerModal";
import { useTimelineStore } from "../../stores/useTimelineStore";
import type {
  Asset, BibleEntry, Job, ModelCatalogRow, VoiceClone,
} from "../../lib/db/types";

type Tab = "voice" | "sfx" | "music" | "v2a" | "library";
type Lane = "A1" | "A2" | "A3";

/** Which job kind each generator writes, and which lane its output belongs on.
 *  The lane is a default for the one-click "send to timeline", not a rule —
 *  every row can still be dragged anywhere. */
const TAB_JOB: Record<Exclude<Tab, "library">, { kind: string; lane: Lane }> = {
  voice: { kind: "tts", lane: "A3" },
  sfx: { kind: "sfx_gen", lane: "A2" },
  music: { kind: "music_gen", lane: "A1" },
  // A soundtrack written against a clip lands on the effects lane by default:
  // it is a bed for one shot, not the episode's master track.
  v2a: { kind: "v2a_gen", lane: "A2" },
};

/** The six OpenAI `gpt-4o-mini-tts` voices — the ones `handle_tts` actually
 *  accepts. Anything else it silently rewrites to "alloy", which is how the
 *  old picker's `clone_voice_1` came back sounding like alloy. */
const OPENAI_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

/** Delivery words that map onto an ElevenLabs v3 audio tag in
 *  `dialogue_synth.TAG_MAP`, or onto OpenAI TTS `instructions`. Anything not
 *  in the map is a no-op on the v3 path, so the list is the map's own keys
 *  rather than a longer list of moods that mostly do nothing. */
const EMOTIONS = [
  "", "calm", "whispers", "excited", "sad", "angry", "nervous", "pleased",
  "firm", "thoughtful", "surprised", "sarcastic", "afraid", "playful",
];

const SFX_SECONDS = [1, 2, 3, 5, 8, 12, 20, 30, 60];
/** The offered values PLUS the model's own, sorted — see BlockAudioModal. */
const withDefault = (list: number[], v: number) =>
  [...new Set([...list, v])].sort((a, b) => a - b);
const SONG_SECONDS = [15, 30, 60, 90, 120, 180, 240];
const SFX_CATEGORIES = ["sfx", "one-shot", "instrument", "music"];
const KEY_SCALES = ["major", "minor"].flatMap((m) =>
  ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"].map((r) => `${r} ${m}`));

const secs = (ms?: number | null) => (ms ? `${(ms / 1000).toFixed(1)}s` : "—");
const caps = (m: ModelCatalogRow | null) => (m?.capabilities ?? {}) as Record<string, unknown>;

/** A generated asset's stored recipe. Both `music_gen` and `sfx_gen` write the
 *  whole thing onto `assets.meta` so a finished sound can say what it was
 *  asked for — and be handed straight back to the composer. */
interface Recipe {
  prompt?: string;
  lyrics?: string;
  line?: string;
  negative?: string;
  model?: string;
  seed?: number;
  bpm?: number;
  key_scale?: string;
  time_signature?: string;
  instrumental?: boolean;
  category?: string;
  steps?: number;
  cfg?: number;
  source_asset_id?: string;
  voice?: string;
  provider?: string;
  emotion?: string | null;
  requested_ms?: number;
  original_name?: string;
}
const recipeOf = (a: Asset | undefined): Recipe => (a?.meta ?? {}) as Recipe;

/** What to call an asset in a one-line row. */
function titleOf(a: Asset): string {
  const r = recipeOf(a);
  return (r.line || r.prompt || r.original_name || a.b2_key.split("/").pop() || "Audio").trim();
}

/* ------------------------------------------------------------- primitives --- */

/** A labelled pill that opens a menu of values. The whole control row is
 *  built from these so the form stays one line high however many knobs a
 *  model has. */
function Pill<T extends string | number>({
  label, value, options, onPick, format, width = 190,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onPick: (v: T) => void;
  format?: (v: T) => string;
  width?: number;
}) {
  const show = format ?? ((v: T) => String(v));
  return (
    <Dropdown
      width={width}
      trigger={({ open, toggle }) => (
        <button className={`av-pill ${open ? "on" : ""}`} onClick={toggle} type="button">
          <span className="k">{label}</span>
          <span className="v">{show(value)}</span>
          <ChevronDown size={10} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="ws-menu-label">{label}</div>
          {options.map((o) => (
            <button key={String(o)} className={`ws-menu-row ${o === value ? "on" : ""}`}
                    onClick={() => { onPick(o); close(); }}>
              <span style={{ flex: 1 }}>{show(o)}</span>
              {o === value && <Check size={12} />}
            </button>
          ))}
        </>
      )}
    </Dropdown>
  );
}

/** The model line. One row: name, a short reason, a chevron.
 *
 * GROUPED BY WHERE IT RUNS, like every other model picker in the app
 * (`TieredModelMenu`). This one was the last flat list, and the audio tabs are
 * where the tiers differ most sharply: a voice can come from this machine's
 * own key, from the studio's account on the pod, or from an engine that has
 * to be downloaded first — three completely different answers to "what does
 * pressing this cost", and the flat list said none of them.
 *
 * The catalog's `note` still leads each row: those notes are the only place
 * the differences between two checkpoints are written down, and burying them
 * in a `title` attribute is how someone ends up rendering a 6-minute song on
 * the row built for 3-second hits. `TieredModelMenu` appends them through
 * `noteFor`, so the tier heading is added rather than the note replaced.
 */
function ModelLine({
  models, value, onPick, icon,
}: {
  models: ModelCatalogRow[];
  value: ModelCatalogRow | null;
  onPick: (m: ModelCatalogRow) => void;
  icon: React.ReactNode;
}) {
  if (!models.length) {
    return <div className="av-modelline empty">No audio models in the catalog</div>;
  }
  const byId = new Map(models.map((m) => [m.id, m]));
  return (
    <Dropdown
      width={330}
      trigger={({ open, toggle }) => (
        <button className={`av-modelline ${open ? "on" : ""}`} onClick={toggle} type="button">
          <span className="ic">
            {/* The TIER leads the closed control, not the kind icon: with the
                menu shut, "ElevenLabs v3" on the studio's key and the same row
                on yours are the same six words and a different bill. */}
            {value ? <TierIcon tier={tierOf(value)} /> : icon}
          </span>
          <span className="nm">{value?.display_name ?? "Pick a model"}</span>
          {caps(value).turbo === true && <span className="tag">fast</span>}
          <ChevronDown size={12} />
        </button>
      )}
    >
      {(close) => (
        <TieredModelMenu
          models={models} value={value?.id ?? null} close={close}
          onPick={(id) => { const m = byId.get(id); if (m) onPick(m); }}
          noteFor={(m) => (isByokRow(m) ? "your key" : null)} />
      )}
    </Dropdown>
  );
}

/** Play / stop, sized for a list row. */
function PlayBtn({ on, busy, onClick, disabled }: {
  on: boolean; busy?: boolean; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button className={`av-play ${on ? "on" : ""}`} disabled={disabled}
            onClick={(e) => { e.stopPropagation(); onClick(); }}
            title={on ? "Stop" : "Preview"}>
      {busy ? <Loader2 size={11} className="ns-spin" />
        : on ? <Square size={9} /> : <Play size={9} />}
    </button>
  );
}

/* ------------------------------------------------------------------ rows --- */

/** One finished or in-flight piece of audio.
 *
 *  The recipe drawer is the reason this is a component rather than a `<li>`:
 *  a generated track's words and style brief live on `assets.meta`, and until
 *  they were rendered somewhere the only copy a user could reach was in a job
 *  row that scrolls out of the queue. "Reuse" puts them back in the composer,
 *  which is what makes a second take a small edit rather than a retype.
 */
function AudioRow({
  asset, job, playing, onPlay, onDrag, onOpen, onLane, onReuse, defaultLane,
}: {
  asset?: Asset;
  job?: Job;
  playing: boolean;
  onPlay: (a: Asset) => void;
  onDrag: (e: React.DragEvent, a: Asset) => void;
  onOpen: (id: string) => void;
  onLane: (a: Asset, lane: Lane) => void;
  onReuse?: (r: Recipe) => void;
  defaultLane: Lane;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const status = job?.status;
  const ready = !!asset && (!job || status === "done");
  const r = recipeOf(asset);
  const label = asset ? titleOf(asset)
    : String((job?.payload as { label?: string; text?: string; prompt?: string })?.text
      || (job?.payload as { prompt?: string })?.prompt
      || (job?.payload as { label?: string })?.label || "Generating");
  const detail = [r.lyrics, r.prompt].some(Boolean);

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className={`av-row ${ready ? "ready" : ""} ${playing ? "playing" : ""}`}
         draggable={ready} onDragStart={ready && asset ? (e) => onDrag(e, asset) : undefined}>
      <div className="av-rowmain">
        <PlayBtn on={playing} disabled={!ready}
                 busy={status === "running" || status === "queued"}
                 onClick={() => asset && onPlay(asset)} />
        <div className="av-rowtext" onClick={() => (ready && asset ? onOpen(asset.id) : undefined)}>
          <span className="t">{label}</span>
          <span className="m">
            {ready && asset ? (
              <>
                {secs(asset.duration_ms)}
                {r.instrumental ? " · instrumental" : r.lyrics ? " · with lyrics" : ""}
                {r.bpm ? ` · ${r.bpm} BPM` : ""}
                {r.provider ? ` · ${r.provider}` : ""}
              </>
            ) : status === "error" ? (
              <span className="err">{String(job?.error_msg ?? "failed").slice(0, 60)}</span>
            ) : status === "running" ? (
              `rendering ${Math.round((job?.progress ?? 0) * 100)}%`
            ) : (
              status ?? "queued"
            )}
          </span>
        </div>
        {ready && asset && (
          <div className="av-rowacts">
            {detail && (
              <button className={`av-mini ${open ? "on" : ""}`} title="Show what this was made from"
                      onClick={() => setOpen((o) => !o)}>
                <ChevronDown size={11} style={{ transform: open ? "rotate(180deg)" : undefined }} />
              </button>
            )}
            <button className={`av-mini lane ${defaultLane.toLowerCase()}`}
                    title={`Send to timeline lane ${defaultLane}`}
                    onClick={() => onLane(asset, defaultLane)}>
              {defaultLane}
            </button>
          </div>
        )}
      </div>

      {open && (
        <div className="av-recipe">
          {!!r.lyrics && r.lyrics !== "[instrumental]" && (
            <div className="sec">
              <span className="h">
                Lyrics
                <button className="cp" onClick={() => copy(r.lyrics ?? "")}>
                  {copied ? <Check size={10} /> : <Copy size={10} />}
                </button>
              </span>
              <pre>{r.lyrics}</pre>
            </div>
          )}
          {!!r.prompt && (
            <div className="sec">
              <span className="h">Style prompt</span>
              <p>{r.prompt}</p>
            </div>
          )}
          <div className="fct">
            {!!r.model && <span>{r.model}</span>}
            {r.seed != null && <span>seed {r.seed}</span>}
            {!!r.key_scale && <span>{r.key_scale}</span>}
            {!!r.time_signature && <span>{r.time_signature}/4</span>}
            {!!r.category && <span>{r.category}</span>}
            {onReuse && (
              <button className="ru" onClick={() => onReuse(r)}>
                <RotateCcw size={10} /> Reuse
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ main panel --- */

export function AudioVoiceStudio({
  projectId, say, jobs, assetById, cast, catalog, recentAssets,
  playingId, toggle, onDrag, onOpen, llmBackend,
}: {
  projectId: string;
  say: (msg: string, bad?: boolean) => void;
  /** every recent job — this panel picks out its own three kinds */
  jobs: Job[];
  assetById: Map<string, Asset> | undefined;
  cast: BibleEntry[];
  catalog: ModelCatalogRow[];
  recentAssets: Asset[];
  playingId: string | null;
  toggle: (a: Asset) => void;
  onDrag: (e: React.DragEvent, a: Asset) => void;
  onOpen: (id: string) => void;
  llmBackend: string;
}) {
  const [tab, setTab] = useState<Tab>("voice");

  // ── voice
  const [line, setLine] = useState("");
  const [ttsModelId, setTtsModelId] = useState("");
  const [voice, setVoice] = useState("alloy");
  /** a cast member's id when speaking as a character, else "" */
  const [speaker, setSpeaker] = useState("");
  /** a cloned voice's id, on the two providers that speak as one */
  const [cloneId, setCloneId] = useState("");
  const [emotion, setEmotion] = useState("");

  // ── voice cloning
  const [clones, setClones] = useState<VoiceClone[]>([]);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneName, setCloneName] = useState("");
  const [cloneText, setCloneText] = useState("");
  const [cloneSample, setCloneSample] = useState<Asset | null>(null);
  const cloneFileRef = useRef<HTMLInputElement>(null);

  // ── sfx
  const [sfxPrompt, setSfxPrompt] = useState("");
  const [sfxModelId, setSfxModelId] = useState("");
  const [sfxSec, setSfxSec] = useState(3);
  const [sfxCat, setSfxCat] = useState("sfx");
  const [takes, setTakes] = useState(1);

  // ── video -> audio (MMAudio)
  //
  // The one generator on this panel whose INPUT is a clip. Everything else
  // here writes a sound from a sentence; this one watches the frames, so the
  // source picker is the first control rather than an option.
  const [v2aSource, setV2aSource] = useState<Asset | null>(null);
  const [v2aPick, setV2aPick] = useState(false);
  const [v2aPrompt, setV2aPrompt] = useState("");
  const [v2aNeg, setV2aNeg] = useState(DEFAULT_NEGATIVE);
  const [v2aModelId, setV2aModelId] = useState("");
  const [v2aSteps, setV2aSteps] = useState(0);   // 0 = the row's own recipe
  const [v2aCfg, setV2aCfg] = useState(0);
  const [v2aMask, setV2aMask] = useState(false);

  // ── music
  const [musicPrompt, setMusicPrompt] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [instrumental, setInstrumental] = useState(true);
  const [musicModelId, setMusicModelId] = useState("");
  const [songSec, setSongSec] = useState(60);
  const [bpm, setBpm] = useState(120);
  const [keyScale, setKeyScale] = useState("C major");

  const [busy, setBusy] = useState(false);
  const [enhancing, setEnhancing] = useState(false);

  // ── library
  const [libAssets, setLibAssets] = useState<Asset[]>([]);
  const [libSearch, setLibSearch] = useState("");
  const [libCat, setLibCat] = useState<"all" | "voice" | "sfx" | "music" | "uploaded">("all");
  const [uploading, setUploading] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // `kind: "audio"` holds songs, sound effects AND speech, so each picker
  // names its MODE positively — a negation would have quietly swallowed the
  // speech rows the moment they were added, which is what it did to the music
  // list the first time round. Same rule as `catalog.ts`.
  // Local rows are CONCATENATED, exactly as GenComposer does it: what this
  // machine can render is whatever finished downloading, so those rows are
  // derived from `engineCatalog` x `engine_status` and never live in
  // `model_catalog`. Without this the only surface that offers SFX at all
  // could not offer the 3.3GB model that runs on any laptop.
  const engine = useLocalEngine();
  // A SPEECH KEY OF YOUR OWN MOVES A ROW BETWEEN TIERS rather than adding one:
  // `elevenlabs-v3` is in the catalog and enabled because the STUDIO holds a
  // key, and what your own changes is whose card is billed and which machine
  // speaks — the desktop runs `handlers/tts` here with it. See
  // `markSpeechRows`, and `speakHere` below for why it is gated.
  const byok = useByok();
  const [speakHere, setSpeakHere] = useState(false);
  useEffect(() => { void plannerInstalled().then(setSpeakHere); }, []);
  // The local speech service, so its row moves tier with it. `undefined` until
  // the first answer — `markDesktopRows` reads that as "no opinion" and leaves
  // the row on the pod's tier rather than flashing "install it".
  const [breeze, setBreeze] = useState<BreezeStatus | null | undefined>(undefined);
  const [qwen, setQwen] = useState<QwenStatus | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const ask = () => {
      void breezeStatus().then((b) => { if (live) setBreeze(b); });
      void qwenStatus().then((q) => { if (live) setQwen(q); });
    };
    ask();
    const h = setInterval(ask, 5000);
    return () => { live = false; clearInterval(h); };
  }, []);
  // ...and the same for the rows that render through the BUNDLED PIPELINE
  // rather than through `localGraphs` — MMAudio. Composed rather than merged:
  // one marks by KEY (whose card is billed), the other by WEIGHTS AND PACKS
  // (which machine claims the job), and a row can legitimately be neither.
  const rows = useMemo(
    () => markDesktopRows(
      markSpeechRows([...catalog, ...engine.rows], byok.keyed, speakHere),
      { status: engine.status, planner: speakHere, engineUp: engine.running,
        breeze, qwen }),
    [catalog, engine.rows, engine.status, engine.running, byok.keyed, speakHere,
     breeze, qwen]);
  const byMode = (mode: string, orBlank = false) => rows
    .filter((m) => m.kind === "audio"
      && (m.modes?.includes(mode) || (orBlank && !m.modes?.length)))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.sort - b.sort);
  const musicModels = useMemo(() => byMode("t2m", true), [rows]);
  const sfxModels = useMemo(() => byMode("t2sfx"), [rows]);
  const ttsModels = useMemo(() => byMode("tts"), [rows]);
  const v2aModels = useMemo(() => byMode("v2a"), [rows]);
  const musicModel = musicModels.find((m) => m.id === musicModelId) ?? musicModels[0] ?? null;
  const sfxModel = sfxModels.find((m) => m.id === sfxModelId) ?? sfxModels[0] ?? null;
  const ttsModel = ttsModels.find((m) => m.id === ttsModelId) ?? ttsModels[0] ?? null;
  const v2aModel = v2aModels.find((m) => m.id === v2aModelId) ?? v2aModels[0] ?? null;
  const v2aDef = useMemo(() => v2aDefaults(v2aModel), [v2aModel]);
  /** The length the render will actually be, clamped the way the worker
   *  clamps it — so the number under the button is the number delivered.
   *  Falls back to the model's trained length for a source whose row has no
   *  duration yet (an upload the pod has not ingested). */
  const v2aSec = useMemo(
    () => clampSeconds(v2aSource?.duration_ms ?? v2aDef.trainedSeconds * 1000,
                       v2aDef.maxSeconds),
    [v2aSource, v2aDef]);
  const v2aNote = useMemo(
    () => durationNote(v2aSec, v2aDef.trainedSeconds), [v2aSec, v2aDef]);

  /** The worker's provider key for the selected row.
   *
   *  `model_catalog.provider` is the VENDOR column and usually carries it —
   *  but it says WHERE a row runs for the local ones, so every engine hosted
   *  by the studio reads `local`, which is not a `handle_tts.PROVIDERS` value
   *  at all. A one-off ternary covered Fish and missed Breeze, and the failure
   *  is silent in the worst way: `_pick_provider` logs the unknown name and
   *  falls through to OPENAI, so picking "Breeze TTS 2 (local)" rendered an
   *  OpenAI line in a stock voice. A TABLE is what stops the next one.
   *
   *  Pinned by `speechProviders.test.ts` against both `gen_model_catalog.py`
   *  (the ids exist) and `handlers/tts.PROVIDERS` (the values are real). */
  const ttsProvider = ttsModel ? providerOf(ttsModel) : "openai";
  const clonesHere = useMemo(
    () => clones.filter((c) => c.provider === ttsProvider),
    [clones, ttsProvider]);
  /** CAN clone vs MUST clone, and they are different questions. The two Fish
   *  rows have no other voice source, so the whole picker is their clone list.
   *  ElevenLabs has the cast as well — and its clones are the valuable ones,
   *  because what it returns is an ordinary voice id that `recast_voice` can
   *  put on a character for a whole episode. */
  const canClone = caps(ttsModel).cloning != null;
  const mustClone = ttsProvider === "fish" || ttsProvider === "fish-local";
  /** ...and CAST, which is a third question again. Some engines cast a
   *  character a voice for the whole episode — ElevenLabs a stock id, each
   *  LOCAL engine a designed clip — and auditioning a line on one any other
   *  way is not an audition of the take you will get. `castVoiceOf` is where
   *  each keeps it, and it already reads the key off the provider name, so
   *  this is the only place that had to learn there is more than one. */
  const castsHere = (p: string) =>
    p === "elevenlabs" || (LOCAL_ENGINES as readonly string[]).includes(p);
  const hasCast = castsHere(ttsProvider);
  /** Spoken on THIS machine — two different reasons, one lane.
   *
   *  A BYOK row because the pod cannot read this keychain; a local engine
   *  because it IS this machine. Derived once so `genVoice` and `makeClone`
   *  cannot disagree about where a voice was made and where it is spoken. */
  const speaksHere = isByokRow(ttsModel ?? { id: "", capabilities: {} })
    || isDesktopReady(ttsModel);
  const clone = clonesHere.find((c) => c.id === cloneId) ?? null;

  /** ACE-Step conditions on BPM / key as typed encoder inputs; Music 3 has no
   *  such fields and wants them written into the caption instead. Showing them
   *  on a Music 3 row would be a control that provably cannot change the
   *  render. */
  const musicalMeta = caps(musicModel).musicalMeta === true;
  const songCap = Math.max(15, musicModel?.max_seconds ?? 300);
  const sfxCap = Math.max(1, sfxModel?.max_seconds ?? 120);

  /** Cast members THIS ENGINE has a voice for — i.e. the voice the EPISODE
   *  actually speaks in. Auditioning a line any other way is not an audition
   *  of the take you will get. Characters planned before voices were cast have
   *  no id and are left out rather than listed and silently downgraded.
   *
   *  Per ENGINE, not per character: a cast is engine-specific (ElevenLabs a
   *  stock id, each local engine a designed clip at its own `doc.<engine>_
   *  voice`), so switching the picker legitimately empties this list — the
   *  character is cast, just not on the engine now selected. `castVoiceOf`
   *  is where each keeps it. */
  const voiced = useMemo(
    () => cast.filter((c) => castVoiceOf(c, ttsProvider) !== null),
    [cast, ttsProvider]);

  const fetchLibrary = async () => {
    try {
      setLibAssets(await loadAssets({ projectId, kind: "audio", limit: 120 }));
    } catch {
      setLibAssets(recentAssets.filter((a) => a.kind === "audio"));
    }
  };
  useEffect(() => { void fetchLibrary(); }, [projectId, recentAssets.length]);

  const fetchClones = async () => {
    try {
      setClones(await loadVoiceClones(projectId));
    } catch (e) {
      say(`Could not load cloned voices: ${String((e as Error).message).slice(0, 120)}`);
    }
  };
  useEffect(() => { void fetchClones(); }, [projectId]);
  // A hosted registration is a round trip through the worker, so the row lands
  // `pending` and resolves seconds later. Realtime covers it, but this panel is
  // rendered inside a rail that may not be mounted when the event arrives —
  // poll only while something is actually pending, and not otherwise.
  useEffect(() => {
    if (!clones.some((c) => c.status === "pending")) return;
    const t = window.setInterval(() => void fetchClones(), 4000);
    return () => window.clearInterval(t);
  }, [clones, projectId]);

  const allAudio = useMemo(() => {
    const map = new Map<string, Asset>();
    recentAssets.filter((a) => a.kind === "audio").forEach((a) => map.set(a.id, a));
    libAssets.forEach((a) => map.set(a.id, a));
    (assetById ? [...assetById.values()] : []).filter((a) => a.kind === "audio")
      .forEach((a) => map.set(a.id, a));
    return [...map.values()].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [recentAssets, libAssets, assetById]);

  /** The jobs this tab made, newest first — live, so a row shows queued →
   *  rendering N% → done without waiting for the asset query. */
  const tabJobs = useMemo(() => {
    if (tab === "library") return [];
    const kind = TAB_JOB[tab].kind;
    return jobs.filter((j) => j.kind === kind).slice(0, 6);
  }, [jobs, tab]);

  const filteredLib = useMemo(() => allAudio.filter((a) => {
    if (libSearch && !titleOf(a).toLowerCase().includes(libSearch.toLowerCase())) return false;
    const r = recipeOf(a);
    const hint = (a.meta as { kind_hint?: string })?.kind_hint;
    if (libCat === "uploaded") return a.origin === "uploaded";
    if (libCat === "voice") return hint === "voice" || a.tags.includes("voiceover");
    if (libCat === "sfx") return hint === "sfx" || a.tags.includes("sfx");
    if (libCat === "music") return hint === "music" || a.tags.includes("music") || !!r.lyrics;
    return true;
  }), [allAudio, libSearch, libCat]);

  /* ------------------------------------------------------------ actions --- */

  const sendToLane = (asset: Asset, lane: Lane) => {
    const st = useTimelineStore.getState();
    const idx = lane === "A1" ? 0 : lane === "A2" ? 1 : 2;
    const track = st.tracks.find((t) => t.name === lane)
      ?? st.tracks.filter((t) => t.kind === "audio")[idx];
    if (!track) {
      say(`No ${lane} audio lane on this timeline yet — drag the clip onto one instead.`);
      return;
    }
    // THE END OF THE LANE, not 0. "Added to A1" means appended, and it used to
    // land there only because `insertAsset` broke a tie at 0 in favour of the
    // clip already sitting there. An insert at X now goes BEFORE anything
    // starting at X (laneInsert.ts), so asking for 0 would stack every track
    // sent here in reverse. Said explicitly rather than relying on the tie.
    const endMs = st.clips
      .filter((c) => c.track_id === track.id)
      .reduce((m, c) => Math.max(m, c.t_start_ms + c.duration_ms), 0);
    void st.insertAsset(asset, track.id, endMs, { label: titleOf(asset).slice(0, 40) });
    say(`Added to ${lane}.`, false);
  };

  /** One enqueue path for all three generators, so the two things every
   *  enqueuer here owes the rest of the app — `payload.label` for the queue
   *  surfaces, and an immediate `jobs` invalidation so the row appears on this
   *  tick rather than after the socket round trip — cannot be remembered in
   *  one branch and forgotten in another. */
  const queue = async (
    kind: string, payload: Record<string, unknown>, label: string,
    opts: {
      lane?: "cpu" | "gpu"; modelId?: string; count?: number; done?: string;
      /** run it on THIS machine, whatever the model row's tier says. Set for a
       *  speech row whose key is in this keychain: the pod has no way to read
       *  it, so the pod's lane would be a job it cannot serve. */
      here?: boolean;
    } = {},
  ) => {
    if (busy) return false;
    setBusy(true);
    try {
      const n = Math.max(1, opts.count ?? 1);
      for (let i = 0; i < n; i++) {
        await enqueueJob({
          // A DESKTOP model goes on the local lane or nothing claims it: the
          // pod's query filters by lane and a `local:` id means weights on
          // THIS machine that model_map has never heard of. Derived from the
          // model rather than passed in, so no call site can forget it.
          kind, lane: opts.here || isLocalId(opts.modelId)
            ? "local" : (opts.lane ?? "gpu"),
          priority: USER_PRIORITY,
          project_id: projectId, model_id: opts.modelId,
          payload: {
            ...payload, project_id: projectId,
            label: n > 1 ? `${label} · take ${i + 1}` : label,
            // ALWAYS a fresh seed, not just across takes. There is no seed
            // control on this panel, so without one every job would carry the
            // worker's default of 0 — and "press generate again", the most
            // obvious next action here, would render the identical sound. The
            // seed lands on the asset either way, so a take you liked is still
            // reproducible; what is gone is the silent duplicate. (GenComposer
            // reaches the same place from the other side: it CLEARS a pinned
            // seed after generating, for exactly this reason.)
            seed: Math.floor(Math.random() * 2 ** 31),
          },
        });
      }
      invalidateTables(["jobs"]);
      say(n > 1 ? `${n} takes queued.` : opts.done ?? "Queued.", false);
      return true;
    } catch (e) {
      say(`Could not queue: ${String((e as Error).message).slice(0, 140)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const genVoice = async () => {
    const text = line.trim();
    if (!text) return;
    if (mustClone && !clone) {
      say("Pick a cloned voice, or switch engine — this one only speaks as one.");
      return;
    }
    // On ElevenLabs a clone and a cast member are the same kind of value, so
    // whichever was picked last wins; `clone` is checked first below.
    const who = hasCast && !clone
      ? voiced.find((c) => c.id === speaker) : null;
    const label = clone?.name ?? who?.name ?? voice;
    // The line itself survives the click — a second read with a different
    // delivery is the common next action here, the same reason the generate
    // composer keeps its prompt.
    await queue("tts", {
      text,
      // Explicit, always. Inference is the fallback in `handle_tts` for old
      // callers; a picker that relies on it is a picker that can be wrong.
      provider: ttsProvider,
      ...(clone ? { voice_clone_id: clone.id } : {}),
      ...(who ? { speaker_entry_id: who.id, speaker: who.name } : {}),
      ...(!clone && !who ? { voice } : {}),
      ...(emotion ? { emotion } : {}),
      // Which key Rust may put in the child's environment. NAMED, never "every
      // key on the machine": reaching for one nobody chose is the silent spend
      // `routeHere` refuses, and here the choice is the model row itself.
      ...(isByokRow(ttsModel ?? { id: "", capabilities: {} })
        ? { byok_providers: [ttsModel!.provider] } : {}),
    }, `${label} · ${text.slice(0, 40)}`,
    {
      lane: "cpu", modelId: ttsModel?.id,
      // YOUR KEY MEANS YOUR MACHINE. The pod cannot read this keychain, so a
      // row marked byok has to be spoken here — `handlers/tts` is one of the
      // kinds the desktop's own Python runs, with the key put in its
      // environment by Rust and never handed to this webview.
      here: speaksHere,
      done: `Queued as ${label}${speaksHere ? ", on this machine" : ""}.`,
    });
  };

  /** Make a cloned voice from an uploaded clip.
   *
   *  The row goes in `pending` and a cpu job does the registering, because the
   *  provider key is server-side only (invariant #1). What this function owes
   *  the user is the two checks it can make in the browser — a name and a
   *  sample — since both failures are otherwise a job that errors a few
   *  seconds later for no visible reason. */
  const makeClone = async () => {
    const name = cloneName.trim();
    if (!name || !cloneSample || busy) return;
    setBusy(true);
    try {
      const created = await createVoiceClone({
        name, provider: ttsProvider as VoiceClone["provider"],
        sampleAssetId: cloneSample.id, sampleText: cloneText,
        projectId,
        // Registering a clone spends the provider key, so it follows the same
        // rule as speaking a line: your key, your machine.
        here: speaksHere,
      });
      setClones((c) => [...c, created]);
      setCloneId(created.id);
      setCloneOpen(false);
      setCloneName(""); setCloneText(""); setCloneSample(null);
      invalidateTables(["jobs"]);
      say(ttsProvider === "fish"
        ? `Registering "${name}" with Fish Audio — it will be pickable in a moment.`
        : `"${name}" is ready — s2-pro clones from the clip itself.`, false);
    } catch (e) {
      say(`Could not create the voice: ${String((e as Error).message).slice(0, 140)}`);
    } finally {
      setBusy(false);
    }
  };

  const removeClone = async (c: VoiceClone) => {
    try {
      await deleteVoiceClone(c.id);
      setClones((list) => list.filter((x) => x.id !== c.id));
      if (cloneId === c.id) setCloneId("");
      // The recording stays in the library on purpose — see deleteVoiceClone.
      say(`Removed "${c.name}". Its reference clip is still in the library.`, false);
    } catch (e) {
      say(`Could not remove it: ${String((e as Error).message).slice(0, 120)}`);
    }
  };

  const genSfx = async () => {
    const p = sfxPrompt.trim();
    if (!p || !sfxModel) return;
    await queue("sfx_gen", {
      prompt: p, duration_ms: Math.min(sfxSec, sfxCap) * 1000,
      model_key: modelKeyOf(sfxModel.id), category: sfxCat,
    }, `sfx · ${p.slice(0, 40)}`, { modelId: sfxModel.id, count: takes });
  };

  const genMusic = async () => {
    const p = musicPrompt.trim();
    if (!p || !musicModel) return;
    await queue("music_gen", {
      prompt: p, instrumental,
      ...(instrumental ? {} : { lyrics: lyrics.trim() }),
      duration_ms: Math.min(songSec, songCap) * 1000,
      model_key: modelKeyOf(musicModel.id),
      ...(musicalMeta ? { bpm, key_scale: keyScale } : {}),
    }, `music · ${p.slice(0, 40)}`, { modelId: musicModel.id });
  };

  /** Score the picked clip. Unlike every other generator here the payload is
   *  built by `lib/mmaudio` rather than inline, so this tab and the timeline's
   *  "Change audio" popup cannot drift on what they send — they are the same
   *  render with different destinations. */
  const genV2a = async () => {
    if (!v2aSource || !v2aModel) return;
    const payload = v2aPayload({
      sourceAssetId: v2aSource.id,
      model: v2aModel,
      modelKey: modelKeyOf(v2aModel.id),
      prompt: v2aPrompt,
      negative: v2aNeg,
      durationMs: v2aSource.duration_ms ?? v2aDef.trainedSeconds * 1000,
      steps: v2aSteps || undefined,
      cfg: v2aCfg || undefined,
      maskAwayClip: v2aMask,
      projectId,
    });
    // `queue` overwrites `seed` with a fresh roll of its own, which is the
    // behaviour every generator on this panel wants and `v2aPayload` already
    // provides — passing through is fine, the values agree.
    await queue("v2a_gen", payload, v2aLabel({ prompt: v2aPrompt }),
                // A bundled-pipeline row keeps its CATALOG id (it is one row,
                // marked, not a `local:` one), so `here` is what puts the job
                // on the lane this machine claims — and `localWorker` then
                // sends it to the bundled Python because `PY_KINDS` has the
                // kind and the id is not a `local:` one.
                { modelId: v2aModel.id, count: takes, here: isDesktopReady(v2aModel) });
  };

  /** Rewrite the style/sound brief against the selected model's own prompt
   *  guide. Cheap, no side effects, and falls forward across backends — the
   *  same contract the generate composer's enhance button has. */
  const enhance = async () => {
    // Three composers now, and the KIND is what picks the guide. Coercing a
    // video-to-audio brief to `sfx` is not merely generic — that guide tells
    // you to end with "Length: N seconds" (the clip decides it here), to write
    // ONE sound (a shot has several at once) and to avoid negations (the
    // negative prompt is a live control at cfg 4.5). See prompt_guides.js.
    const which: "music" | "sfx" | "v2a" =
      tab === "music" ? "music" : tab === "v2a" ? "v2a" : "sfx";
    const text = (which === "music" ? musicPrompt
      : which === "v2a" ? v2aPrompt : sfxPrompt).trim();
    const model = which === "music" ? musicModel
      : which === "v2a" ? v2aModel : sfxModel;
    if (!text || enhancing) return;
    setEnhancing(true);
    const body = {
      prompt: text, kind: which as "music" | "sfx" | "v2a",
      family: model?.family ?? null,
      mode: which === "music" ? "t2m" : which === "v2a" ? "v2a" : "t2sfx",
      model_label: model?.display_name ?? null,
      project_id: projectId, backend: llmBackend,
    };
    try {
      // No key prompt: the rewrite runs on this machine, and a machine that
      // cannot answer says so in the message the outer catch reports. There is
      // nothing a text box here could supply.
      const res = await enhancePrompt(body);
      (which === "music" ? setMusicPrompt
        : which === "v2a" ? setV2aPrompt : setSfxPrompt)(res.prompt);
      const how = res.guide.exact
        ? `Rewritten with the ${res.guide.label} guide`
        : `No stored guide for this model — rewritten with general ${
          which === "music" ? "music" : "sound design"} craft`;
      const hops = res.fell_back ?? [];
      say(hops.length ? `${hops[0].from} ${hops[0].reason} — ${res.backend} wrote this. ${how}.`
        : `${how}.`, !!hops.length);
    } catch (e) {
      say(`Could not enhance: ${describeDirectorError(String((e as Error).message || e))}`);
    } finally {
      setEnhancing(false);
    }
  };

  /** Load a finished piece's recipe back into its composer. */
  const reuse = (r: Recipe, into: "sfx" | "music" | "v2a") => {
    if (into === "v2a") {
      setV2aPrompt(r.prompt ?? "");
      setV2aNeg(r.negative ?? "");
      if (r.steps) setV2aSteps(r.steps);
      if (r.cfg) setV2aCfg(r.cfg);
      // The SOURCE is part of the recipe here, and it is the part you most
      // want back — a prompt with no clip cannot be re-rendered at all.
      const src = r.source_asset_id ? assetById?.get(r.source_asset_id) : null;
      if (src) setV2aSource(src);
      setTab("v2a");
      say(src ? "Loaded into the composer — change something and generate again."
        : "Loaded the prompt. Its source clip is not in this view — pick it again.",
        !src);
      return;
    }
    if (into === "music") {
      setMusicPrompt(r.prompt ?? "");
      setLyrics(r.lyrics && r.lyrics !== "[instrumental]" ? r.lyrics : "");
      setInstrumental(!!r.instrumental);
      if (r.bpm) setBpm(r.bpm);
      if (r.key_scale) setKeyScale(r.key_scale);
      if (r.requested_ms) setSongSec(Math.round(r.requested_ms / 1000));
      setTab("music");
    } else {
      setSfxPrompt(r.prompt ?? "");
      if (r.category) setSfxCat(r.category);
      if (r.requested_ms) setSfxSec(Math.round(r.requested_ms / 1000));
      setTab("sfx");
    }
    say("Loaded into the composer — change something and generate again.", false);
  };

  /** Upload audio into the project's library. Returns what it registered —
   *  the clone form needs the asset it just made, and re-querying for "the
   *  newest audio row" would race with anything else finishing at the same
   *  moment. */
  const onUpload = async (files: FileList | File[]): Promise<Asset[]> => {
    const made: Asset[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("audio/")) {
        say(`"${file.name}" is not an audio file.`);
        continue;
      }
      const ext = (file.name.match(/\.[a-z0-9]+$/i) || [".mp3"])[0].toLowerCase();
      const key = `audio/${projectId}/${Date.now()}_${crypto.randomUUID().slice(0, 8)}${ext}`;
      setUploading(0);
      try {
        await uploadMedia(file, key, (p: number) => setUploading(p));
        const asset = await registerAsset({
          b2_key: key, kind: "audio", project_id: projectId,
          content_type: file.type || "audio/mpeg", bytes: file.size,
          origin: "uploaded", tags: ["audio", "user-upload"],
          meta: { original_name: file.name },
          // The length, measured here rather than waited for: `asset_ingest`
          // runs on the pod, and a track uploaded while it is stopped is a row
          // that says nothing about how long it is. Ingest still runs below for
          // the peaks; it just is not what a clip's length depends on.
          ...(await probedUploadMeta(file)),
        });
        await enqueueJob({
          kind: "asset_ingest", lane: "cpu", priority: 60,
          payload: { asset_id: asset.id },
        });
        made.push(asset);
        say(`Uploaded ${file.name}.`, false);
        void fetchLibrary();
      } catch (e) {
        say(`Upload failed: ${String((e as Error).message).slice(0, 120)}`);
      } finally {
        setUploading(null);
      }
    }
    return made;
  };

  /* --------------------------------------------------------------- view --- */

  const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "voice", label: "Voice", icon: <Mic size={14} /> },
    { id: "sfx", label: "SFX", icon: <Volume2 size={14} /> },
    { id: "music", label: "Music", icon: <Music size={14} /> },
    { id: "v2a", label: "Video", icon: <Film size={14} /> },
    { id: "library", label: "Library", icon: <FolderOpen size={14} /> },
  ];

  const results = (kindTab: Exclude<Tab, "library">) => {
    const rows = tabJobs;
    if (!rows.length) return null;
    return (
      <div className="av-results">
        <span className="av-h">Recent</span>
        {rows.map((j) => (
          <AudioRow key={j.id} job={j} asset={assetById?.get(j.output_asset_id ?? "")}
                    playing={!!j.output_asset_id && playingId === j.output_asset_id}
                    onPlay={toggle} onDrag={onDrag} onOpen={onOpen} onLane={sendToLane}
                    defaultLane={TAB_JOB[kindTab].lane}
                    onReuse={kindTab === "voice" ? undefined
                      : (r) => reuse(r, kindTab as "sfx" | "music" | "v2a")} />
        ))}
      </div>
    );
  };

  return (
    <div className="av">
      {/* THE LABEL RIDES ON THE SELECTED TAB ONLY. Five labelled tabs need
          305px and this rail gives 256, so the strip used to overflow and the
          last one was clipped mid-word with its tally off-screen — see
          `.av-tabs` in workspace.css for why `flex: 1` could not absorb it.
          The label stays in the DOM while collapsed, so an icon-only tab is
          still named for a screen reader; `title` covers the pointer. */}
      <div className="av-tabs" role="tablist" aria-label="Audio studio mode">
        {TABS.map((t) => (
          <button key={t.id} className={`av-tab ${tab === t.id ? "on" : ""}`}
                  role="tab" aria-selected={tab === t.id} title={t.label}
                  onClick={() => setTab(t.id)}>
            {t.icon}<span className="av-lbl">{t.label}</span>
            {/* Collapsed there is no room for digits, so the tally becomes a
                presence dot — the count is what made this the widest tab. */}
            {t.id === "library" && !!allAudio.length && (
              tab === "library"
                ? <span className="ct">{allAudio.length}</span>
                : <span className="av-dot" />
            )}
          </button>
        ))}
      </div>

      {/* ───────────────────────────────────────────────────────── VOICE ── */}
      {tab === "voice" && (
        <div className="av-card">
          {/* WHICH ENGINE. A real choice now: `handle_tts` reads
              `payload.provider` and each row is a code path it can reach. The
              picker this replaced listed five engines the worker never read,
              so every one of them rendered as OpenAI's `alloy`. */}
          <ModelLine models={ttsModels} value={ttsModel} icon={<Mic size={12} />}
                     onPick={(m) => { setTtsModelId(m.id); setCloneId(""); }} />

          {/* WHICH VOICE. Its shape follows the engine, because the engines
              genuinely differ: stock voices, the cast's own, a clone — and on
              ElevenLabs, both of the last two at once. */}
          <Dropdown
            width={286}
            trigger={({ open, toggle: t }) => (
              <button className={`av-voiceline ${open ? "on" : ""}`} onClick={t} type="button">
                <span className="nm">
                  {clone?.name
                    ?? (mustClone
                      ? (clonesHere.length ? "Pick a voice" : "No cloned voices yet")
                      : hasCast
                        ? (voiced.find((c) => c.id === speaker)?.name ?? "Pick a cast member")
                        : voice)}
                </span>
                <span className="tag">
                  {clone ? "cloned" : mustClone ? "cloned"
                    : hasCast ? "cast" : "stock"}
                </span>
                <ChevronDown size={12} />
              </button>
            )}
          >
            {(close) => (
              <>
                {/* The cast first where there is one: it is what an episode
                    actually speaks in, so it is the common pick. */}
                {hasCast && (
                  <>
                    <div className="ws-menu-label">Cast — their episode voice</div>
                    {voiced.map((c) => (
                      <button key={c.id}
                              className={`ws-menu-row ${!clone && speaker === c.id ? "on" : ""}`}
                              onClick={() => { setSpeaker(c.id); setCloneId(""); close(); }}>
                        <span style={{ flex: 1 }}>{c.name}</span>
                        {!clone && speaker === c.id && <Check size={12} />}
                      </button>
                    ))}
                    {!voiced.length && (
                      <div className="ws-menu-empty">
                        No cast voices yet — characters are cast when an episode
                        is planned.
                      </div>
                    )}
                    <div className="ws-menu-sep" />
                  </>
                )}
                {ttsProvider === "openai" && (
                  <>
                    <div className="ws-menu-label">Stock voices</div>
                    {OPENAI_VOICES.map((v) => (
                      <button key={v} className={`ws-menu-row ${voice === v ? "on" : ""}`}
                              onClick={() => { setVoice(v); close(); }}>
                        <span style={{ flex: 1 }}>{v}</span>
                        {voice === v && <Check size={12} />}
                      </button>
                    ))}
                  </>
                )}
                {canClone && (
                  <>
                    <div className="ws-menu-label">Cloned voices</div>
                    {clonesHere.map((c) => (
                      <button key={c.id} className={`ws-menu-row ${cloneId === c.id ? "on" : ""}`}
                              disabled={c.status !== "ready"}
                              onClick={() => { setCloneId(c.id); close(); }}>
                        <span style={{ flex: 1 }}>{c.name}</span>
                        {c.status === "pending" && <Loader2 size={11} className="ns-spin" />}
                        {c.status === "error" && (
                          <span className="av-bad" title={c.error_msg ?? ""}>failed</span>
                        )}
                        {cloneId === c.id && c.status === "ready" && <Check size={12} />}
                        <span className="av-x" title="Remove this voice"
                              onClick={(e) => { e.stopPropagation(); void removeClone(c); }}>
                          <Trash2 size={10} />
                        </span>
                      </button>
                    ))}
                    {!clonesHere.length && (
                      <div className="ws-menu-empty">Nothing cloned on this engine yet.</div>
                    )}
                    <button className="ws-menu-row"
                            onClick={() => { setCloneOpen(true); close(); }}>
                      <Plus size={12} /><span style={{ flex: 1 }}>Clone a voice…</span>
                    </button>
                  </>
                )}
              </>
            )}
          </Dropdown>

          {/* CLONE FORM. Inline rather than a modal: it is three fields, and
              the picker it feeds is the row directly above it. */}
          {cloneOpen && (
            <div className="av-clone">
              <div className="av-clonehead">
                <UserPlus size={12} />
                <span>Clone a voice</span>
                <button className="av-x" onClick={() => setCloneOpen(false)}>
                  <X size={11} />
                </button>
              </div>
              <button className={`av-drop ${cloneSample ? "on" : ""}`}
                      onClick={() => cloneFileRef.current?.click()}
                      disabled={uploading !== null}>
                {uploading !== null
                  ? <><Loader2 size={12} className="ns-spin" /> {Math.round(uploading * 100)}%</>
                  : cloneSample
                    ? <><Check size={12} /> {secs(cloneSample.duration_ms)} clip attached</>
                    : <><Upload size={12} /> Choose a 10–30s recording</>}
              </button>
              <input ref={cloneFileRef} type="file" hidden accept="audio/*"
                     onChange={async (e) => {
                       const made = e.target.files?.length
                         ? await onUpload(e.target.files) : [];
                       if (made[0]) setCloneSample(made[0]);
                     }} />
              <input className="av-inp" value={cloneName} maxLength={80}
                     placeholder="Name this voice"
                     onChange={(e) => setCloneName(e.target.value)} />
              <textarea className="av-text ns-scroll" rows={2} value={cloneText}
                        placeholder="What is said in the clip (optional — it matches better with it)"
                        onChange={(e) => setCloneText(e.target.value)} />
              <button className="av-go voice" disabled={!cloneName.trim() || !cloneSample || busy}
                      onClick={() => void makeClone()}>
                {busy ? <Loader2 size={13} className="ns-spin" /> : <UserPlus size={13} />}
                <span>Create the voice</span>
              </button>
              <span className="av-hint">
                {ttsProvider === "elevenlabs"
                  ? "Registered with ElevenLabs. The id it returns is an ordinary voice, so this clone can also be cast onto a character."
                  : ttsProvider === "fish"
                    ? "The clip is registered with Fish Audio once; every later line cites it."
                    : "Zero-shot — the clip is read again at every line, nothing is uploaded."}
              </span>
            </div>
          )}

          <div className="av-field">
            <textarea className="av-text ns-scroll" rows={3} value={line}
                      placeholder="The line to speak. One take per generation."
                      onChange={(e) => setLine(e.target.value)} />
            <span className="av-count">{line.length}</span>
          </div>

          {/* Delivery is a v3/s2 audio tag on the engines that read one, and
              plain prose instructions on OpenAI. Fish's hosted API takes
              neither — it applies the clone's own prosody, and a stray tag is
              read out loud — so the control is hidden rather than ignored. */}
          {caps(ttsModel).delivery !== "none" && (
            <div className="av-ctls">
              <Pill label="Delivery" value={emotion} options={EMOTIONS} onPick={setEmotion}
                    format={(v) => v || "neutral"} />
            </div>
          )}

          <button className="av-go voice"
                  disabled={!line.trim() || busy || (mustClone && !clone)}
                  onClick={() => void genVoice()}>
            {busy ? <Loader2 size={13} className="ns-spin" /> : <Mic size={13} />}
            <span>Speak the line</span>
          </button>
          {hasCast && !voiced.length && (
            <span className="av-hint">
              No cast voices yet — characters are cast when an episode is planned.
              {(LOCAL_ENGINES as readonly string[]).includes(ttsProvider)
                ? " Without one this reads in a voice designed from the delivery note."
                : " Switch to OpenAI for stock narration voices."}
            </span>
          )}
          {mustClone && !clonesHere.length && (
            <span className="av-hint">
              This engine only speaks as a cloned voice. Clone one from a
              10–30s recording of the speaker.
            </span>
          )}
          {ttsProvider === "elevenlabs" && !!clonesHere.length && (
            <span className="av-hint">
              A voice cloned here is an ordinary ElevenLabs voice, so the
              director can cast it onto a character — ask it to
              "recast &lt;name&gt; to &lt;the clone&gt;" and the whole episode
              speaks in it.
            </span>
          )}
          {results("voice")}
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────── SFX ── */}
      {tab === "sfx" && (
        <div className="av-card">
          <ModelLine models={sfxModels} value={sfxModel} icon={<Volume2 size={12} />}
                     onPick={(m) => setSfxModelId(m.id)} />

          <div className="av-field">
            <textarea className="av-text ns-scroll" rows={3} value={sfxPrompt}
                      placeholder="One sound: what makes it, what it is made of, what happens to it, and the space it happens in."
                      onChange={(e) => setSfxPrompt(e.target.value)} />
            <button className="av-wand" disabled={!sfxPrompt.trim() || enhancing}
                    title="Rewrite against this model's prompt guide"
                    onClick={() => void enhance()}>
              {enhancing ? <Loader2 size={12} className="ns-spin" /> : <Wand2 size={12} />}
            </button>
          </div>

          <div className="av-ctls">
            <Pill label="Length" value={sfxSec} options={SFX_SECONDS.filter((s) => s <= sfxCap)}
                  onPick={setSfxSec} format={(v) => `${v}s`} width={140} />
            <Pill label="Kind" value={sfxCat}
                  options={(caps(sfxModel).categories as string[] | undefined) ?? SFX_CATEGORIES}
                  onPick={setSfxCat} width={160} />
            <Pill label="Takes" value={takes} options={[1, 2, 3, 4]} onPick={setTakes}
                  format={(v) => `${v}`} width={120} />
          </div>

          <button className="av-go sfx" disabled={!sfxPrompt.trim() || !sfxModel || busy}
                  onClick={() => void genSfx()}>
            {busy ? <Loader2 size={13} className="ns-spin" /> : <Volume2 size={13} />}
            <span>{takes > 1 ? `Generate ${takes} takes` : "Generate sound"}</span>
          </button>
          {results("sfx")}
        </div>
      )}

      {/* ────────────────────────────────────────────────── VIDEO → AUDIO ── */}
      {tab === "v2a" && (
        <div className="av-card">
          <ModelLine models={v2aModels} value={v2aModel} icon={<Film size={12} />}
                     onPick={(m) => setV2aModelId(m.id)} />

          {/* THE SOURCE IS THE FIRST CONTROL, because without one there is
              nothing to score. Every other generator on this panel writes a
              sound from a sentence; this one watches frames. */}
          <button className={`av-src ${v2aSource ? "on" : ""}`}
                  onClick={() => setV2aPick(true)}>
            {v2aSource ? (
              <>
                <video className="th" src={mediaUrl(v2aSource.b2_key) ?? undefined} muted preload="metadata" />
                <span className="col">
                  <b>{titleOf(v2aSource)}</b>
                  <em>{v2aSource.width && v2aSource.height
                    ? `${v2aSource.width}×${v2aSource.height} · ` : ""}
                    {secs(v2aSource.duration_ms)}</em>
                </span>
                <RotateCcw size={12} />
              </>
            ) : (
              <>
                <Video size={14} />
                <span className="col">
                  <b>Pick a clip to score</b>
                  <em>Any video in the library or the bible</em>
                </span>
              </>
            )}
          </button>

          <div className="av-field">
            <textarea className="av-text ns-scroll" rows={3} value={v2aPrompt}
                      placeholder="The sound sources you want to hear, most important first — 'boots on wet gravel, a chain-link gate, distant traffic'."
                      onChange={(e) => setV2aPrompt(e.target.value)} />
            <button className="av-wand" disabled={!v2aPrompt.trim() || enhancing}
                    title="Rewrite against this model's prompt guide"
                    onClick={() => void enhance()}>
              {enhancing ? <Loader2 size={12} className="ns-spin" /> : <Wand2 size={12} />}
            </button>
          </div>

          {/* A REAL control here, unlike every distilled audio row on this
              panel: MMAudio samples at cfg 4.5, so the uncond branch is
              evaluated and the vendor's own advice is to use it. Hidden where
              a row's cfg would make it inert. */}
          {v2aDef.takesNegative && (
            <div className="av-neg">
              <label htmlFor="av-v2a-neg">
                Negative prompt <em>sounds to keep out</em>
              </label>
              <input id="av-v2a-neg" className="av-line" value={v2aNeg}
                     placeholder="e.g. music, speech, voices"
                     onChange={(e) => setV2aNeg(e.target.value)} />
            </div>
          )}

          <div className="av-ctls">
            {/* The row's OWN recipe is always in the list. A Pill renders
                whatever value it is handed, but the menu is what says which
                values exist — and a default absent from it reads as a value
                nobody can get back to once they have moved off it. */}
            <Pill label="Steps" value={v2aSteps || v2aDef.steps}
                  options={withDefault([10, 15, 25, 35, 50], v2aDef.steps)}
                  onPick={setV2aSteps} format={(v) => `${v}`} width={120} />
            <Pill label="Guidance" value={v2aCfg || v2aDef.cfg}
                  options={withDefault([3, 3.5, 4, 4.5, 5, 6, 7], v2aDef.cfg)}
                  onPick={setV2aCfg} format={(v) => v.toFixed(1)} width={140} />
            <Pill label="Takes" value={takes} options={[1, 2, 3, 4]} onPick={setTakes}
                  format={(v) => `${v}`} width={120} />
          </div>

          {/* THE LENGTH IS THE CLIP'S, and is stated rather than offered.
              Kijai's node truncates a render to `frames / 25` when the staged
              batch is short, so the worker stages at exactly 25fps and this
              number is the one it will deliver — see lib/mmaudio.ts. */}
          {v2aSource && (
            <div className="av-hint">
              <b>{v2aSec.toFixed(1)}s</b> — the clip's own length,
              {" "}{framesNeeded(v2aSec, v2aDef.syncFps)} frames at {v2aDef.syncFps}fps.
              {v2aNote && <span className="warn"> {v2aNote}</span>}
            </div>
          )}

          <label className="av-check" title={
            "Drops the visual semantics and keeps only the timing, so the sound "
            + "follows the motion but is described entirely by your prompt. Worth "
            + "trying when the picture is stylised, very dark, or misleading about "
            + "what is making the noise."}>
            <input type="checkbox" checked={v2aMask}
                   onChange={(e) => setV2aMask(e.target.checked)} />
            <span>Ignore what it looks like, keep the timing</span>
          </label>

          <button className="av-go sfx" disabled={!v2aSource || !v2aModel || busy}
                  onClick={() => void genV2a()}>
            {busy ? <Loader2 size={13} className="ns-spin" /> : <Film size={13} />}
            <span>{!v2aSource ? "Pick a clip first"
              : takes > 1 ? `Score it ${takes} ways` : "Score this clip"}</span>
          </button>
          {results("v2a")}
        </div>
      )}

      {/* ───────────────────────────────────────────────────────── MUSIC ── */}
      {tab === "music" && (
        <div className="av-card">
          <ModelLine models={musicModels} value={musicModel} icon={<Music size={12} />}
                     onPick={(m) => setMusicModelId(m.id)} />

          <div className="av-field">
            <textarea className="av-text ns-scroll" rows={3} value={musicPrompt}
                      placeholder={caps(musicModel).promptStyle === "tags"
                        ? "Tags, strongest first: genre, instruments, vocal, mood, era."
                        : "Describe the record: genre and tempo, the vocal, then the arrangement and the production."}
                      onChange={(e) => setMusicPrompt(e.target.value)} />
            <button className="av-wand" disabled={!musicPrompt.trim() || enhancing}
                    title="Rewrite against this model's prompt guide"
                    onClick={() => void enhance()}>
              {enhancing ? <Loader2 size={12} className="ns-spin" /> : <Wand2 size={12} />}
            </button>
          </div>

          <div className="av-seg">
            <button className={instrumental ? "on" : ""} onClick={() => setInstrumental(true)}>
              Instrumental
            </button>
            <button className={!instrumental ? "on" : ""} onClick={() => setInstrumental(false)}>
              With vocals
            </button>
          </div>
          {!instrumental && (
            <textarea className="av-text lyr ns-scroll" rows={4} value={lyrics}
                      placeholder={"[Verse]\nThe words to sing — section tags are read.\n\n[Chorus]\n…"}
                      onChange={(e) => setLyrics(e.target.value)} />
          )}

          <div className="av-ctls">
            <Pill label="Length" value={songSec} options={SONG_SECONDS.filter((s) => s <= songCap)}
                  onPick={setSongSec}
                  format={(v) => (v >= 60 ? `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}` : `${v}s`)}
                  width={140} />
            {musicalMeta && (
              <>
                <Pill label="BPM" value={bpm} options={[70, 80, 90, 100, 110, 120, 128, 140, 160, 174]}
                      onPick={setBpm} width={130} />
                <Pill label="Key" value={keyScale} options={KEY_SCALES} onPick={setKeyScale}
                      width={170} />
              </>
            )}
          </div>

          <button className="av-go music"
                  disabled={!musicPrompt.trim() || !musicModel || busy}
                  onClick={() => void genMusic()}>
            {busy ? <Loader2 size={13} className="ns-spin" /> : <Music size={13} />}
            <span>Compose</span>
          </button>
          {!musicalMeta && !!musicModel && (
            <span className="av-hint">
              This model plans its own tempo and length — the duration is a ceiling
              it may finish under, and there is no beat grid for block snapping.
            </span>
          )}
          {results("music")}
        </div>
      )}

      {/* ─────────────────────────────────────────────────────── LIBRARY ── */}
      {tab === "library" && (
        <div className="av-card">
          <div className="av-search">
            <Search size={12} className="ic" />
            <input value={libSearch} placeholder="Search this project's audio"
                   onChange={(e) => setLibSearch(e.target.value)} />
            {libSearch && (
              <button className="cl" onClick={() => setLibSearch("")}><X size={11} /></button>
            )}
            <button className="up" disabled={uploading !== null}
                    onClick={() => fileRef.current?.click()}
                    title="Upload an audio file into this project">
              {uploading !== null
                ? <span className="pct">{Math.round(uploading * 100)}%</span>
                : <Upload size={12} />}
            </button>
            <input ref={fileRef} type="file" multiple hidden
                   accept="audio/*,.mp3,.wav,.flac,.m4a,.ogg,.aac"
                   onChange={(e) => e.target.files?.length && void onUpload(e.target.files)} />
          </div>

          <div className="av-cats">
            {(["all", "voice", "sfx", "music", "uploaded"] as const).map((c) => (
              <button key={c} className={libCat === c ? "on" : ""} onClick={() => setLibCat(c)}>
                {c === "all" ? "All" : c === "voice" ? "Dialogue" : c === "uploaded" ? "Uploaded"
                  : c === "sfx" ? "SFX" : "Music"}
              </button>
            ))}
          </div>

          <div className="av-results">
            {filteredLib.map((a) => {
              // `kind_hint` is written by all three generators; an uploaded or
              // pre-hint asset has none, and lands on the dialogue lane with
              // no Reuse — there is no recipe to reload, and guessing one
              // would drop a voiceover's fields into the SFX composer.
              const hint = (a.meta as { kind_hint?: string })?.kind_hint;
              return (
                <AudioRow key={a.id} asset={a} playing={playingId === a.id}
                          onPlay={toggle} onDrag={onDrag} onOpen={onOpen} onLane={sendToLane}
                          defaultLane={hint === "music" ? "A1" : hint === "sfx" ? "A2" : "A3"}
                          onReuse={hint === "music" || hint === "sfx" || hint === "v2a"
                            ? (r) => reuse(r, hint) : undefined} />
              );
            })}
            {!filteredLib.length && (
              <div className="av-empty">
                Nothing here yet. Generate a line, a sound or a track — or upload one.
              </div>
            )}
          </div>
        </div>
      )}

      {/* The source picker. `kindFilter: "video"` makes this the one asset
          browse on this panel that is NOT about audio — and it uploads too, so
          a clip that is not in the project yet can be dropped straight in. */}
      {v2aPick && (
        <AssetPickerModal
          projectId={projectId}
          title="Pick a clip to score"
          kindFilter="video"
          onPick={(picks) => { if (picks[0]) setV2aSource(picks[0].asset); }}
          onClose={() => setV2aPick(false)} />
      )}
    </div>
  );
}


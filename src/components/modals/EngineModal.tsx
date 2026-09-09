// The local engine: install it, run it, give it models.
//
// THE DESIGN PROBLEM THIS SOLVES. Installing ComfyUI is four things (an
// interpreter, the app, its Python dependencies, weights) of which three are
// invisible and one takes ten minutes, and every existing installer either
// hides all of it behind a spinner or exposes all of it as a terminal. Neither
// is right: hidden, a ten-minute step reads as a hang; exposed, it reads as
// someone else's problem. So the four steps are named and ticked off, the one
// that has a size shows a bar, and the one that has no measurable size
// (pip resolving) shows what it is doing instead.
//
// MODELS ARE A SEPARATE DECISION FROM THE ENGINE, and the screen keeps them
// apart. The engine is ~2GB and identical for everyone; the weights are the
// part that depends on the machine, costs the bandwidth, and can be added to
// later. Bundling them into one "Install" would make the first run twice as
// long and give someone with a 16GB laptop no way to say "not that one".
//
// ADD-ONS ARE A CHECKLIST, CHECKPOINTS ARE A CHOICE — because that is what
// they are. A checkpoint replaces what renders; an adapter changes how. The
// LCM add-on is the one that matters most on a laptop: measured here, SD 1.5
// at 20 steps takes 74s on an M3, and LCM does it in 4.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Boxes, Check, ChevronDown, Cpu, Download, ExternalLink, Film, FolderOpen, HardDrive, Loader2,
  Mic, Play, Plug, KeyRound, Square, Terminal, Trash2, TriangleAlert, Zap,
} from "lucide-react";
import ModalShell from "./ModalShell";
import OllamaSection from "./OllamaSection";
import BreezeSection from "./BreezeSection";
import QwenSection from "./QwenSection";
import ApiKeysSection from "./ApiKeysSection";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import {
  activeDownloads, detectHardware, invoke, isDesktop, listen, machineBudgetGb,
  machineRamGb, openExternal, pickComfyDir, setLinkedComfy,
  type ActiveDownload, type EngineStatus, type HardwareProfile,
} from "../../lib/desktop";
import { comfyLog, openComfy, pingComfy, type ComfyStatus } from "../../lib/comfyLocal";
import { clearSetup } from "./FirstRunSetupModal";
import {
  POST_PROCESS, audioFamilies, bestVariant, blockedFiles, fitNote, fits, fmtSize,
  familyBlocker, imageFamilies, mirrorIndex, resolveSource, type MirrorIndex,
  variantFiles, variantInstalled, variantMb, variantRemainingMb, videoFamilies,
  type EngineFile, type FamilyAddon, type ModelVariant, type PostTool,
} from "../../lib/engineCatalog";
import { NO_RECIPE, localRecipe } from "../../lib/localGraphs";
import { markFor } from "../../lib/desktopRows";

const INK = "#c7cddb";
const MUTE = "#5e6678";
const OK = "#6fd08c";
const WARN = "#e8a13a";
const BAD = "#e8734a";
const ACCENT = "#5aa2ff";

interface Progress { step: number; label: string; pct: number; detail: string }
interface DlProgress { id: string; received: number; total: number; done: boolean }

/** The four questions this window answers, one per tab.
 *
 *  IT WAS ONE SCROLL, and that stopped working when the fourth thing landed.
 *  The engine, its weights, the local LLM and now the API keys are four
 *  separate decisions with four separate failure modes, and stacking them made
 *  the one you came for a scroll away from the one above it — the keys section
 *  in particular would have opened below several screens of gigabyte downloads
 *  that have nothing to do with it. They are also genuinely independent: a
 *  machine can be all keys and no engine, or the reverse.
 *
 *  ENGINE AND MODELS STAY APART for the reason the module header already gives
 *  for keeping them visually separate — the engine is ~2GB and identical for
 *  everyone, the weights are the part that depends on the machine. */
type Tab = "engine" | "models" | "llm" | "speech" | "keys";

const TABS: { id: Tab; label: string; icon: React.ReactNode; note: string }[] = [
  { id: "engine", label: "Engine", icon: <Boxes size={12} />,
    note: "ComfyUI on this machine" },
  { id: "models", label: "Models", icon: <HardDrive size={12} />,
    note: "weights to render with" },
  { id: "llm", label: "Local LLM", icon: <Cpu size={12} />,
    note: "an uncensored director, offline" },
  { id: "speech", label: "Speech", icon: <Mic size={12} />,
    note: "a voice engine on this machine" },
  { id: "keys", label: "API keys", icon: <KeyRound size={12} />,
    note: "hosted models on your own keys" },
];

/** Module-level rather than a store: it is one enum, read and written by one
 *  component, and it must NOT survive a reload — see the note at `tab`. */
let lastTab: Tab = "engine";

function Tabs({ tab, onPick }: { tab: Tab; onPick: (t: Tab) => void }) {
  return (
    <div role="tablist" aria-label="Local engine"
         style={{ display: "flex", gap: 4, borderBottom: "1px solid rgba(255,255,255,0.07)",
                  margin: "-2px 0 2px" }}>
      {TABS.map((t) => {
        const on = t.id === tab;
        return (
          <button key={t.id} role="tab" aria-selected={on} title={t.note}
                  className="ws-link"
                  onClick={() => onPick(t.id)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    padding: "7px 11px 8px", fontSize: 12,
                    fontWeight: on ? 600 : 500,
                    color: on ? INK : MUTE,
                    borderBottom: `2px solid ${on ? ACCENT : "transparent"}`,
                    marginBottom: -1,
                  }}>
            {t.icon}{t.label}
          </button>
        );
      })}
    </div>
  );
}

const STEPS = [
  { n: 1, label: "Python runtime + ffmpeg",
    note: "private to this app — nothing on your system is touched" },
  { n: 2, label: "ComfyUI", note: "the render engine itself" },
  { n: 3, label: "Dependencies", note: "PyTorch and the rest — the long step" },
  { n: 4, label: "Models", note: "pick these below once the engine is in" },
];

function Bar({ pct, tone = ACCENT }: { pct: number; tone?: string }) {
  const indeterminate = pct < 0;
  return (
    <div className="ns-dlbar" style={{
      height: 4, borderRadius: 3, background: "rgba(255,255,255,0.07)",
      overflow: "hidden", position: "relative",
    }}>
      <div style={{
        height: "100%", borderRadius: 3, background: tone,
        width: indeterminate ? "35%" : `${Math.round(Math.min(1, Math.max(0, pct)) * 100)}%`,
        transition: indeterminate ? undefined : "width .25s ease",
        animation: indeterminate ? "ns-slide 1.4s ease-in-out infinite" : undefined,
        opacity: indeterminate ? 0.75 : 1,
      }} />
    </div>
  );
}

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className="mono" style={{
      fontSize: 10, padding: "2px 7px", borderRadius: 999, whiteSpace: "nowrap",
      color: tone, background: `${tone}1a`, border: `1px solid ${tone}3d`,
    }}>{children}</span>
  );
}

const PRECISION_TONE: Record<string, string> = {
  fp16: ACCENT, fp8: ACCENT, int8: ACCENT, gguf: "#aa5bde",
};

/** One variant: the row you actually choose. Deliberately dense — the whole
 *  point of listing five of them is that they are compared at a glance, and a
 *  card each would put the comparison on separate screens. */
function VariantRow({ v, size, remaining, partialMb = 0, state, pct, detail,
                     budgetGb, ramGb = Infinity, disabled, onGet }: {
  v: ModelVariant;
  size: number;
  remaining: number;
  /** already on disk as a half-finished `.part` — pressing Get resumes it */
  partialMb?: number;
  state: "absent" | "downloading" | "installed";
  pct: number;
  detail?: string;
  budgetGb: number;
  /** the machine's system RAM, less headroom. The SECOND gate — see
   *  `ModelVariant.ram_gb`: the rungs that fit the smallest cards are the ones
   *  that want the most of it, so VRAM alone clears rows that cannot run. */
  ramGb?: number;
  disabled?: boolean;
  onGet: () => void;
}) {
  const ok = fits(v, budgetGb, ramGb);
  const note = fitNote(v, budgetGb, ramGb);
  // A row refused on RAM must not show a green VRAM figure beside the refusal —
  // that reads as "it fits" next to a sentence saying it does not.
  const vramOk = fits(v, budgetGb);
  return (
    <div style={{
      display: "flex", gap: 10, alignItems: "center", padding: "8px 10px",
      borderRadius: 9, opacity: ok ? 1 : 0.55,
      background: state === "installed" ? "rgba(111,208,140,0.07)" : "rgba(255,255,255,0.02)",
      border: `1px solid ${state === "installed" ? "rgba(111,208,140,0.22)" : "rgba(255,255,255,0.05)"}`,
    }}>
      <div style={{ minWidth: 132, flex: "0 0 auto", display: "flex", gap: 6, alignItems: "center" }}>
        <span className="mono" style={{ fontSize: 11.5, fontWeight: 600 }}>{v.label}</span>
        {v.precision === "gguf" && (
          <span className="mono" title="Quantised — the installer adds the loader it needs"
                style={{
                  fontSize: 9, padding: "1px 5px", borderRadius: 4,
                  color: PRECISION_TONE.gguf, background: `${PRECISION_TONE.gguf}1a`,
                  border: `1px solid ${PRECISION_TONE.gguf}3d`,
                }}>GGUF</span>
        )}
      </div>
      <span className="mono" style={{ fontSize: 11, color: MUTE, minWidth: 96, flex: "0 0 auto" }}>
        {remaining < size
          ? <>{fmtSize(remaining)}<span style={{ opacity: 0.55 }}> of {fmtSize(size)}</span></>
          : fmtSize(size)}
      </span>
      <span className="mono" style={{
        fontSize: 11, minWidth: 58, flex: "0 0 auto", color: vramOk ? OK : WARN,
      }} title={v.ram_gb
        ? `${v.vram_gb}GB VRAM · ${v.ram_gb}GB system RAM, both measured`
        : `${v.vram_gb}GB VRAM`}>~{v.vram_gb}GB</span>
      {v.ram_gb != null && (
        <span className="mono" title="system RAM this rung was measured needing"
              style={{
                fontSize: 11, minWidth: 62, flex: "0 0 auto",
                color: (v.ram_gb ?? 0) <= ramGb ? MUTE : WARN,
              }}>{v.ram_gb}GB RAM</span>
      )}
      <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: ok ? MUTE : WARN }}>
        {state === "downloading"
          ? <span className="mono">{detail ?? "starting…"}</span>
          : partialMb > 0
            // A stopped download is otherwise indistinguishable from one never
            // started — the whole row reads "Get 10.4 GB" with no sign that a
            // gigabyte of it is already on disk.
            ? <span style={{ color: ACCENT }}>
                {fmtSize(partialMb)} already fetched — picks up where it stopped
              </span>
            : note ?? v.quality}
        {v.tag && ok && state !== "downloading" && (
          <span className="mono" style={{
            marginLeft: 6, fontSize: 9, padding: "1px 5px", borderRadius: 4,
            color: OK, background: `${OK}1a`, border: `1px solid ${OK}3d`,
          }}>{v.tag}</span>
        )}
        {state === "downloading" && <div style={{ marginTop: 4 }}><Bar pct={pct} /></div>}
      </span>
      <div style={{ flex: "0 0 auto" }}>
        {state === "installed" ? (
          <span style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 11, color: OK }}>
            <Check size={12} /> installed
          </span>
        ) : (
          <button className="ws-actbtn" style={{ fontSize: 11, padding: "4px 9px" }}
                  disabled={disabled || !ok || state === "downloading"}
                  title={ok ? "" : note ?? ""}
                  onClick={onGet}>
            {state === "downloading"
              ? <Loader2 size={11} className="ns-spin" />
              : <Download size={11} />} {partialMb > 0 && state === "absent" ? "Resume" : "Get"}
          </button>
        )}
      </div>
    </div>
  );
}

const KIND_TONE: Record<string, string> = {
  speed: "#e8a13a", quality: ACCENT, capability: "#6fd08c",
};

/** An adapter or tool. Deliberately lighter than a variant row: these are
 *  additive and optional, and giving them the same weight as the model would
 *  make a 300MB LoRA look like a decision on the scale of a 9GB checkpoint. */
function AddonRow({ a, state, pct, detail, disabled, note, onGet }: {
  a: { id: string; name: string; blurb: string; tag?: string; recipe?: string;
       kind?: string; files: { filename: string; size_mb: number }[] };
  state: "absent" | "downloading" | "installed";
  pct: number;
  detail?: string;
  disabled?: boolean;
  note?: string;
  onGet: () => void;
}) {
  const mb = a.files.reduce((n, f) => n + f.size_mb, 0);
  return (
    <div style={{
      display: "flex", gap: 9, alignItems: "flex-start", padding: "7px 9px",
      borderRadius: 8,
      background: state === "installed" ? "rgba(111,208,140,0.06)" : "rgba(255,255,255,0.015)",
      border: `1px solid ${state === "installed"
        ? "rgba(111,208,140,0.2)" : "rgba(255,255,255,0.05)"}`,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {a.kind && (
            <span className="mono" style={{
              fontSize: 9, padding: "1px 5px", borderRadius: 4,
              color: KIND_TONE[a.kind] ?? MUTE, background: `${KIND_TONE[a.kind] ?? MUTE}1a`,
              border: `1px solid ${KIND_TONE[a.kind] ?? MUTE}3d`,
            }}>{a.kind}</span>
          )}
          <span style={{ fontSize: 11.5, fontWeight: 600 }}>{a.name}</span>
          <span className="mono" style={{ fontSize: 10, color: MUTE }}>{fmtSize(mb)}</span>
          {a.tag && <Pill tone={OK}>{a.tag}</Pill>}
        </div>
        <p style={{ fontSize: 11, color: MUTE, margin: "3px 0 0", lineHeight: 1.45 }}>{a.blurb}</p>
        {a.recipe && (
          <span className="mono" style={{ fontSize: 9.5, color: MUTE, display: "block", marginTop: 2 }}>
            {a.recipe}
          </span>
        )}
        {note && <span style={{ fontSize: 10.5, color: WARN, display: "block", marginTop: 3 }}>{note}</span>}
        {state === "downloading" && (
          <div style={{ marginTop: 5 }}>
            <Bar pct={pct} />
            <span className="mono" style={{ fontSize: 9.5, color: MUTE }}>{detail ?? "starting…"}</span>
          </div>
        )}
      </div>
      <div style={{ flex: "none", paddingTop: 2 }}>
        {state === "installed" ? (
          <span style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 10.5, color: OK }}>
            <Check size={11} /> installed
          </span>
        ) : (
          <button className="ws-actbtn" style={{ fontSize: 10.5, padding: "3px 8px" }}
                  disabled={disabled || state === "downloading"} onClick={onGet}>
            {state === "downloading" ? <Loader2 size={10} className="ns-spin" /> : <Download size={10} />} Get
          </button>
        )}
      </div>
    </div>
  );
}

export default function EngineModal({ tab: want }: { tab?: Tab } = {}) {
  const ws = useWorkspaceStore();
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [hw, setHw] = useState<HardwareProfile | null>(null);
  const [comfy, setComfy] = useState<ComfyStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [prog, setProg] = useState<Progress | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dl, setDl] = useState<Record<string, number>>({});
  /** "file 2 of 3 · umt5…" while a multi-file model downloads */
  const [dlNote, setDlNote] = useState<Record<string, string>>({});
  /** per-FILE progress, keyed by filename — what the Rust side emits */
  const [dlFile, setDlFile] = useState<Record<string, number>>({});
  const [log, setLog] = useState<string>("");
  const [showLog, setShowLog] = useState(false);
  const [starting, setStarting] = useState(false);
  // Which tab is open survives a close and reopen for the session, so
  // "install a key, close, come back" does not land on the engine tab again.
  // Not persisted past a reload: the engine is the right place to open on a
  // fresh start, since it is the one that can be in a broken state.
  // A CALLER'S TAB WINS over the remembered one. `want` is set by whatever
  // opened this to answer its own refusal — a picker's "add your openai key"
  // means the keys screen, not the engine installer it would otherwise
  // remember. Read once, as the initial value, so switching tabs afterwards
  // still works and still sticks for the session.
  const [tab, setTab] = useState<Tab>(want ?? lastTab);
  useEffect(() => { lastTab = tab; }, [tab]);
  const unlisten = useRef<(() => void)[]>([]);
  /** Keys whose `get()` loop THIS component instance is driving. `syncActive`
   *  must not clear one of these during the gap between two files of a
   *  multi-file model, when nothing is momentarily in flight. */
  const owned = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const s = await invoke<EngineStatus>("engine_status");
    setStatus(s);
    setComfy(await pingComfy());
  }, []);

  /**
   * Adopt whatever is already downloading.
   *
   * The Rust task outlives this component, so an empty `dl` means "this mount
   * has not started anything", NOT "nothing is happening" — reopening the
   * modal mid-download used to read the second way and offer a Download button
   * for a file 1.6GB in. Taking that offer opened a second writer on the same
   * `.part`. This asks the registry instead.
   */
  const syncActive = useCallback(async () => {
    const active = await activeDownloads();
    const live = new Set(active.map((a) => a.id));
    setDlFile((prev) => {
      const next = { ...prev };
      for (const a of active) next[a.id] = a.total ? a.received / a.total : -1;
      return next;
    });
    // Adopt by OWNER, never by filename. A filename cannot say which row
    // wanted it: the shared text encoder belongs to every variant in its
    // family, so matching on it marked all of them "downloading" at once —
    // five rows claiming to be fetching the same file.
    const byOwner = new Map<string, ActiveDownload>();
    for (const a of active) if (a.owner) byOwner.set(a.owner, a);
    setDl((prev) => {
      const next: Record<string, number> = {};
      // Keep what this mount owns; adopt anything the registry attributes.
      for (const k of Object.keys(prev)) if (owned.current.has(k)) next[k] = prev[k];
      for (const key of byOwner.keys()) next[key] ??= -1;
      return next;
    });
    setDlNote((prev) => {
      const next = { ...prev };
      for (const [key, a] of byOwner) {
        if (owned.current.has(key)) continue;      // its own loop writes a better note
        next[key] = `resuming · ${a.id}`;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    void refresh();
    void syncActive();
    void detectHardware().then(setHw);
    // Progress arrives as events rather than a polled endpoint: pip prints for
    // minutes with nothing to poll, and a bar that only moves when someone
    // asks is what makes an install feel hung.
    (async () => {
      const a = await listen<Progress>("engine://progress", (p) => setProg(p));
      const b = await listen<DlProgress>("download://progress", (p) => {
        setDlFile((d) => ({ ...d, [p.id]: p.done ? 1 : p.total ? p.received / p.total : -1 }));
        // A finished FILE may or may not finish its MODEL — a multi-file
        // download moves straight on to the next one. Re-asking the registry
        // is what distinguishes the two, and it is also what retires an
        // adopted row this component has no `get()` loop to clean up after.
        if (p.done) { void refresh(); void syncActive(); }
      });
      unlisten.current = [a, b].filter(Boolean) as (() => void)[];
    })();
    return () => { unlisten.current.forEach((f) => f()); };
  }, [refresh, syncActive]);

  // While the engine is running, poll it — a cold ComfyUI takes a minute or
  // two to start listening, and the chip must notice on its own.
  useEffect(() => {
    if (!status?.running) return;
    const h = setInterval(() => { void pingComfy().then(setComfy); }, 4000);
    return () => clearInterval(h);
  }, [status?.running]);

  // WHOSE LOG, and a LINKED ENGINE HAS ONE TOO.
  //
  // `engine_log` reads `comfyui.log` out of our own engine root, so it is the
  // right answer for an engine we spawned and structurally empty for one the
  // user already runs — which is a first-class setup here. That made the log
  // panel permanently blank in exactly the setup where the studio's own error
  // message ("the graph errored — see the ComfyUI log") sends you to it.
  //
  // ComfyUI serves its own at `/internal/logs/raw`, so a linked engine needs
  // nothing from us. Ours keeps the FILE, deliberately: it captures stdout
  // from process start, where the endpoint can only answer once the server is
  // listening — and on a cold start that gap is a minute or two of exactly the
  // output worth reading when the boot itself went wrong.
  useEffect(() => {
    if (!showLog) return;
    let alive = true;
    const ours = !!status?.running;
    const put = (l: string) => { if (alive) setLog(l); };
    const tick = async () => {
      if (ours) { put((await invoke<string>("engine_log", { lines: 60 })) ?? ""); return; }
      try {
        put(await comfyLog(undefined, 60));
      } catch {
        // Not ours and not answering. Our own file may still hold the tail of
        // an engine we ran earlier, which is better than an empty panel; when
        // it does not, say which engine this is about rather than showing "…"
        // for ever.
        const own = (await invoke<string>("engine_log", { lines: 60 })) ?? "";
        put(own || "This ComfyUI was started outside the app, so its log comes from "
                 + "the engine itself — and it is not answering on "
                 + "127.0.0.1:8188 right now.");
      }
    };
    void tick();
    const h = setInterval(() => void tick(), 2500);
    return () => { alive = false; clearInterval(h); };
  }, [showLog, status?.running]);

  /** `which: "utilities"` installs the two things that are not a render
   *  engine — the planner's Python and ffmpeg — and stops. Everything the
   *  one-shot wizard and the timeline renderer need, none of the gigabytes
   *  that only ComfyUI does. See `install_utilities`'s own note for why a
   *  Python they already have is not the answer, and why ffmpeg is the
   *  opposite case. */
  const install = async (which: "engine" | "utilities" = "engine") => {
    setInstalling(true); setErr(null); setProg(null);
    try {
      const s = await invoke<EngineStatus>(which === "utilities" ? "install_utilities" : "install_engine");
      if (!s) throw new Error("the installer returned nothing — see the log");
      setStatus(s);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setInstalling(false);
      void refresh();
    }
  };

  /**
   * Fetch every file a model needs, one at a time, skipping any already on
   * disk. Sequential rather than parallel on purpose: four concurrent
   * multi-gigabyte streams on a laptop connection finish no sooner and make
   * the progress meaningless.
   */
  // Takes real `EngineFile`s now rather than a structural subset: the source
  // resolution below reads `gated` as well as `url`, and a narrowed type would
  // have dropped it silently — the download would then start against a URL
  // that answers 401.
  const get = async (key: string, files: EngineFile[]) => {
    setErr(null);
    const have = new Set(status?.files ?? []);
    const todo = files.filter((f) => !have.has(f.filename));
    owned.current.add(key);
    setDl((d) => ({ ...d, [key]: -1 }));
    try {
      for (const [i, f] of todo.entries()) {
        setDlNote((n) => ({ ...n, [key]: `file ${i + 1} of ${todo.length} · ${f.filename}` }));
        const dest = await invoke<string>("engine_model_path",
          { kind: f.dir, filename: f.filename });
        if (!dest) throw new Error(`could not resolve where to put ${f.filename}`);
        // The download id is the FILE, not the model — two models sharing a
        // text encoder would otherwise report each other's progress.
        // `owner` is the catalogue key, and it is what makes a resumed
        // download attributable to ONE row. Without it the adoption below
        // falls back to matching filenames, and a shared file (umt5 is 6.5GB
        // and belongs to every Wan variant) marks the whole family as
        // downloading.
        // WHERE THE BYTES COME FROM is resolved per file, not baked into the
        // catalogue: the studio's own mirror wins when it has the file, and
        // for an upstream-gated one it is the ONLY source. A file with
        // neither refuses HERE rather than starting a download that answers
        // 401 once the progress bar is already on screen.
        const src = resolveSource(f, mirror);
        if (!src.url) throw new Error(`${f.filename}: ${src.why ?? "no source"}`);
        await invoke<string>("download_model_file",
          { id: f.filename, url: src.url, dest, owner: key });
      }
      await refresh();
    } catch (e) {
      setErr(`${key}: ${String((e as Error)?.message ?? e)}`);
    } finally {
      owned.current.delete(key);
      setDl((d) => { const n = { ...d }; delete n[key]; return n; });
      setDlNote((n) => { const x = { ...n }; delete x[key]; return x; });
    }
  };

  const power = async (on: boolean) => {
    setStarting(true); setErr(null);
    try {
      const s = await invoke<EngineStatus>(on ? "start_engine" : "stop_engine");
      if (s) setStatus(s);
      if (on) setShowLog(true);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setStarting(false);
      void refresh();
    }
  };

  if (!isDesktop()) {
    return (
      <ModalShell icon={<Boxes size={15} />} title="Local engine" width={560} onClose={ws.closeModal}>
        <div className="ws-modal-body">
          <div className="ws-card" style={{ fontSize: 12.5, color: INK, lineHeight: 1.6 }}>
            A local engine only exists in the desktop app — a browser tab cannot start a
            process or write weights to disk. Here, renders queue as jobs for the
            studio cloud.
          </div>
        </div>
      </ModalShell>
    );
  }

  // EVERY model directory, not just checkpoints and loras. A modern model is
  // three files in three directories — a GGUF lands in `diffusion_models` and
  // its text encoder in `text_encoders` — so the narrower set meant no GGUF
  // variant could EVER read as installed: a finished 4.2GB Q6_K still offered
  // a plain "Get". `files` is exactly this list and already existed; nothing
  // was reading it.
  const installed = new Set(status?.files ?? []);
  const partial = status?.partial_mb ?? {};
  const gpu = hw?.gpus[0];
  const budgetGb = machineBudgetGb(hw);
  // The second budget. See `ModelVariant.ram_gb`: the H3 rungs that fit the
  // smallest cards want 23-48GB of system RAM, so a machine can clear every
  // VRAM figure on this screen and still be unable to run a single one.
  const ramGb = machineRamGb(hw);
  // A GGUF is a model and it lands in `diffusion_models`, not `checkpoints` —
  // asking only the latter told a machine holding two fully-installed Wan
  // GGUFs it had "no models yet" and left Start engine disabled. The other
  // four directories are ingredients (a LoRA or a VAE alone renders nothing),
  // so they are deliberately not counted here.
  const anyCheckpoint = ["checkpoints", "diffusion_models"]
    .some((d) => (status?.by_dir?.[d] ?? []).length > 0);
  const live = comfy?.reachable;
  // ONE request for the whole catalogue, not a HEAD per file. Null means "not
  // asked yet", which `resolveSource` treats as "no mirror" — so the screen
  // reads exactly as it did before the mirror existed until the answer lands.
  const [mirror, setMirror] = useState<MirrorIndex | null>(null);
  useEffect(() => { void mirrorIndex().then(setMirror); }, []);

  const stateOf = (key: string, files: { filename: string }[]):
    "absent" | "downloading" | "installed" =>
    files.every((f) => installed.has(f.filename)) ? "installed"
      : key in dl ? "downloading" : "absent";

  /** The bar for a multi-file model is the CURRENT file's, which is the only
   *  honest one available — the Rust side reports bytes per request, and
   *  weighting four files by size to fake one smooth bar would be inventing
   *  precision we do not have. */
  /**
   * WHETHER A DOWNLOAD HAS SOMEWHERE TO GO.
   *
   * Not the same question as whether OUR engine is installed — conflating them
   * is what made this whole tab dead for anyone running their own ComfyUI: a
   * download is an HTTPS fetch into a directory and needs no Python of ours,
   * no ComfyUI of ours and nothing running. But it is not "always", either:
   * `models_dir` ALWAYS resolves (it falls back to our own tree, installed or
   * not), so testing that alone offers a Get on a machine with no ComfyUI
   * anywhere. The weights would land in a directory nothing reads, and
   * `install_engine` later untars ComfyUI over that same path.
   *
   * So: an engine of ours to fetch into, or one the user pointed at. Caught by
   * running the harness' CONTROL — the linked state looked right on its own,
   * and only the unlinked one showed the guard had gone.
   */
  const canFetch = !!status && (status.installed || status.models_linked);
  const linkedDir = status?.models_linked ? status.models_dir : null;
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkPath, setLinkPath] = useState("");
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);

  /** Point the catalogue at a ComfyUI of the user's own, or (null) back at
   *  ours. The command REFUSES a path that is not one, and that sentence is
   *  shown rather than swallowed — a typo has to be reported to the person who
   *  made it, or the fallback looks like the feature not working. */
  const link = async (dir: string | null) => {
    setLinkBusy(true);
    setLinkErr(null);
    try {
      await setLinkedComfy(dir);
      await refresh();
      setLinkOpen(false);
      setLinkPath("");
    } catch (e) {
      setLinkErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLinkBusy(false);
    }
  };

  /** The native folder picker. A CANCEL returns null and must leave everything
   *  alone — clearing the field or reporting an error there would make backing
   *  out of a dialog look like a failure. A pick goes straight through `link`,
   *  so the picked folder meets exactly the bar a typed one does; the path is
   *  put in the field FIRST so a refusal shows what was chosen. */
  const browse = async () => {
    setLinkBusy(true);
    setLinkErr(null);
    let picked: string | null = null;
    try {
      picked = await pickComfyDir();
    } finally {
      setLinkBusy(false);
    }
    if (!picked) return;
    setLinkPath(picked);
    await link(picked);
  };

  const pctOf = (key: string, files: { filename: string }[]) => {
    const current = files.find((f) => f.filename in dlFile && dlFile[f.filename] < 1);
    return current ? dlFile[current.filename] : dl[key] ?? -1;
  };

  return (
    <ModalShell
      icon={<Boxes size={15} />}
      title="Local engine"
      context={status?.installed
        ? live ? `running · ComfyUI ${comfy?.version ?? ""} on :${status.port}`
          : status.running ? "starting…" : "installed · stopped"
        // NOT INSTALLED IS NOT THE SAME AS NOTHING WORKS. With a linked
        // ComfyUI the weight catalogue is fully live — only the engine we
        // would have installed is missing — and a bare "not installed" over a
        // working Models tab reads as a broken app.
        : status?.models_linked ? "not installed · using your own ComfyUI"
        : "not installed"}
      width={780}
      tall
      onClose={ws.closeModal}
      footer={
        <>
          <span className="mono" style={{ fontSize: 11, color: MUTE }}>
            {status?.root ?? ""}
          </span>
          {/* The welcome wizard runs once and then never again, which leaves no
              way back to it — and re-reading the hardware is exactly what you
              want after adding a GPU, or when deciding whether to bother. */}
          <button className="ws-actbtn" style={{ fontSize: 11 }}
                  title="Re-read this machine and choose how to render again"
                  onClick={() => { clearSetup(); ws.openModal({ kind: "firstRun" }); }}>
            Run setup again
          </button>
          <div style={{ flex: 1 }} />
          {live && (
            <button className="ws-actbtn" onClick={() => void openComfy()}
                    title="Open ComfyUI's own editor"
                    style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <ExternalLink size={12} />Open ComfyUI
            </button>
          )}
          {status?.installed && (
            <button className="ws-actbtn" onClick={() => setShowLog((v) => !v)}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Terminal size={12} />{showLog ? "Hide log" : "Log"}
            </button>
          )}
          {/* Three states, not two. An engine answering on :8188 that WE did not
              start is the common case for anyone who already runs ComfyUI —
              offering Stop would kill a process we do not own, and offering
              Start would fail on a port already in use. So it says so. */}
          {status?.installed && (
            status.running
              ? <button className="ws-actbtn" disabled={starting} onClick={() => void power(false)}
                        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {starting ? <Loader2 size={12} className="ns-spin" /> : <Square size={12} />} Stop
                </button>
              : live
              ? <span className="mono" style={{ fontSize: 11, color: MUTE }}
                      title="Another ComfyUI is already using this port — Qamba Studio did not start it, so it is not ours to stop">
                  already running · started outside the app
                </span>
              : <button className="ws-primary" disabled={starting || !anyCheckpoint}
                        title={anyCheckpoint ? "" : "Add a model first — there is nothing to render with"}
                        onClick={() => void power(true)}>
                  {starting ? <Loader2 size={13} className="ns-spin" /> : <Play size={13} />} Start engine
                </button>
          )}
        </>
      }
    >
      <div className="ws-modal-body ns-scroll" style={{ display: "flex", flexDirection: "column", gap: 12 }}>

        {err && (
          <div className="ws-card" style={{
            border: "1px solid rgba(232,115,74,0.3)", color: "#f0b9a4", fontSize: 12,
            display: "flex", gap: 8, alignItems: "flex-start",
          }}>
            <TriangleAlert size={14} style={{ flex: "none", marginTop: 1 }} />
            <span style={{ whiteSpace: "pre-wrap" }}>{err}</span>
          </div>
        )}

        <Tabs tab={tab} onPick={setTab} />

        {tab === "engine" && <>
        {/* ── the machine, in one line ─────────────────────────────────── */}
        <div className="ws-card" style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", gap: 7, alignItems: "center", fontSize: 12 }}>
            <Cpu size={13} style={{ color: MUTE }} />
            {gpu ? gpu.name : hw?.cpu ?? "…"}
          </span>
          <span className="mono" style={{ fontSize: 11, color: MUTE }}>
            {gpu?.unified
              ? `${(gpu.vram_mb / 1024).toFixed(0)}GB unified · ~${budgetGb.toFixed(0)}GB usable`
              : gpu ? `${(gpu.vram_mb / 1024).toFixed(0)}GB VRAM` : "no GPU"}
          </span>
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 11, color: MUTE }}>
            <HardDrive size={12} />{hw ? `${(hw.free_disk_mb / 1024).toFixed(0)}GB free` : ""}
          </span>
          <div style={{ flex: 1 }} />
          {live && <Pill tone={OK}>engine live on :{status?.port}</Pill>}
        </div>

        {/* ── install ──────────────────────────────────────────────────── */}
        {!status?.installed ? (
          <div className="ws-card">
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 3 }}>
                  Install a private render engine
                </div>
                <p style={{ fontSize: 12.5, color: INK, margin: 0, lineHeight: 1.55, maxWidth: 560 }}>
                  A self-contained ComfyUI with its own Python, packages and models folder.
                  Nothing on your system is modified and no terminal is involved. About 2GB
                  before you add any weights.
                </p>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch" }}>
                <button className="ws-primary" disabled={installing} onClick={() => void install()}>
                  {installing ? <Loader2 size={13} className="ns-spin" /> : <Download size={13} />}
                  {installing ? "Installing…" : "Install"}
                </button>
                {/* THE UTILITIES ARE NOT A RENDER ENGINE, and offering them
                    separately is the difference between "write a storyboard
                    and cut a timeline" costing ~110MB and costing a torch
                    download. It is also the honest answer for someone who
                    brought their own ComfyUI: they want our Python for the
                    pipeline and an ffmpeg on the PATH, and nothing else.

                    The size is CONDITIONAL because the ffmpeg half is skipped
                    on a machine that already has one — quoting 110MB and then
                    downloading 25 would be the wrong direction to be wrong
                    in. */}
                <button className="ws-ghost" disabled={installing}
                        style={{ fontSize: 11.5, justifyContent: "center" }}
                        title={"The Python the planner runs on, plus ffmpeg — no ComfyUI, "
                               + "no PyTorch"}
                        onClick={() => void install("utilities")}>
                  Utilities only · {status?.ffmpeg ? "~25MB" : "~110MB"}
                </button>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 4 }}>
              {STEPS.map((s) => {
                const active = prog?.step === s.n;
                const done = (prog?.step ?? 0) > s.n || (status?.installed && s.n < 4);
                return (
                  <div key={s.n} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span style={{
                      width: 18, height: 18, borderRadius: 999, flex: "none", marginTop: 1,
                      display: "grid", placeItems: "center", fontSize: 10,
                      color: done ? OK : active ? ACCENT : MUTE,
                      background: done ? "rgba(111,208,140,0.12)" : active ? "rgba(90,162,255,0.12)" : "rgba(255,255,255,0.05)",
                      border: `1px solid ${done ? "rgba(111,208,140,0.35)" : active ? "rgba(90,162,255,0.35)" : "rgba(255,255,255,0.09)"}`,
                    }}>
                      {done ? <Check size={11} /> : s.n}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, color: active ? "#eaeef6" : done ? INK : MUTE }}>
                        {active && prog ? prog.label : s.label}
                        {active && prog?.detail && (
                          <span className="mono" style={{ fontSize: 10.5, color: MUTE }}> · {prog.detail}</span>
                        )}
                      </div>
                      {!active && <div style={{ fontSize: 11, color: MUTE }}>{s.note}</div>}
                      {active && <div style={{ marginTop: 5 }}><Bar pct={prog?.pct ?? -1} /></div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="ws-card" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Plug size={14} style={{ color: live ? OK : MUTE }} />
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                Engine installed
                {comfy?.version && <span className="mono" style={{ fontSize: 10.5, color: MUTE }}> · ComfyUI {comfy.version}</span>}
              </div>
              <span className="mono" style={{ fontSize: 10.5, color: MUTE }}>
                {comfy?.reachable
                  ? [comfy.device, comfy.vram_total_mb && `${(comfy.vram_total_mb / 1024).toFixed(0)}GB`,
                     comfy.python && `python ${comfy.python}`].filter(Boolean).join(" · ")
                  : `${(status.files ?? []).length} model file(s) · start it to see the device`}
              </span>
            </div>
            {!anyCheckpoint && <Pill tone={WARN}>no models yet</Pill>}
          </div>
        )}

        {/* FFMPEG CAN BE MISSING FROM AN ENGINE THAT IS OTHERWISE COMPLETE —
            every install that predates it, and every "link your own ComfyUI"
            setup, which never ran ours at all. Without a row here those users
            have no in-app fix and meet the terminal instruction the utilities
            option exists to remove. */}
        {status && !status.ffmpeg && (status.installed || status.models_linked) && (
          <div className="ws-card" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Film size={14} style={{ color: WARN, flex: "none" }} />
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>ffmpeg is missing</div>
              <span style={{ fontSize: 11, color: MUTE }}>
                Timeline renders, episode cuts and audio effects all need it. About 90MB.
              </span>
            </div>
            <button className="ws-actbtn" disabled={installing} onClick={() => void install("utilities")}>
              {installing ? <Loader2 size={12} className="ns-spin" /> : <Download size={12} />}
              {installing ? "Installing…" : "Get ffmpeg"}
            </button>
          </div>
        )}
        {status?.ffmpeg && !status.ffmpeg_ours && (
          <div className="ws-card" style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <Film size={13} style={{ color: OK, flex: "none" }} />
            <span style={{ fontSize: 12, color: INK }}>
              Using the ffmpeg already on this machine.
            </span>
          </div>
        )}

        </>}

        {tab === "models" && <>
        {/* ── WHERE THESE LAND ────────────────────────────────────────────
            The one line that makes this tab honest for someone who runs
            their own ComfyUI. Every scan and every download used to resolve
            through OUR engine directory, so a machine with a full model tree
            reported nothing installed and greyed out every Get. It is a
            directory question, not an engine question — so the directory is
            stated, and can be pointed elsewhere. */}
        <div className="ws-card" style={{ padding: "10px 12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <HardDrive size={12} style={{ color: linkedDir ? OK : MUTE, flex: "none" }} />
            <span style={{ fontSize: 12 }}>
              {linkedDir ? "Downloads land in your own ComfyUI" : "Downloads land in this app's engine"}
            </span>
            <div style={{ flex: 1 }} />
            <button className="ws-actbtn" disabled={linkBusy}
                    onClick={() => { setLinkErr(null); setLinkOpen(!linkOpen); }}>
              {linkedDir ? "Change" : "Use my own ComfyUI"}
            </button>
            {linkedDir && (
              <button className="ws-actbtn" disabled={linkBusy} onClick={() => void link(null)}>
                Use this app's
              </button>
            )}
          </div>
          <div className="mono" style={{ fontSize: 10, color: MUTE, marginTop: 6, wordBreak: "break-all" }}>
            {status?.models_dir ?? ""}/models
          </div>
          {/* NOT INSTALLED, STILL USABLE — said here because the header's
              "not installed" is about the engine we would have built and
              reads, next to a working catalogue, as if nothing works. */}
          {linkedDir && !status?.installed && (
            <p style={{ fontSize: 10.5, color: MUTE, margin: "6px 0 0", lineHeight: 1.5 }}>
              Downloads work without an engine of ours. Starting and stopping stay yours.
            </p>
          )}
          {linkOpen && (
            <div style={{ marginTop: 8 }}>
              <input className="ws-input mono" style={{ width: "100%", fontSize: 11 }}
                     placeholder="/Users/you/ComfyUI"
                     value={linkPath} disabled={linkBusy}
                     onChange={(e) => setLinkPath(e.target.value)}
                     onKeyDown={(e) => { if (e.key === "Enter") void link(linkPath); }} />
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                <span style={{ fontSize: 10.5, color: MUTE }}>
                  The ComfyUI folder itself — the one with <span className="mono">main.py</span> and{" "}
                  <span className="mono">models/</span> in it.
                </span>
                <div style={{ flex: 1 }} />
                {/* THE PICKER IS THE EASY PATH AND THE FIELD IS THE PRECISE
                    ONE, so both are offered rather than the dialog replacing
                    the input: a path can be pasted from a terminal, and a
                    picker cannot reach a directory the file dialog hides. */}
                <button className="ws-actbtn" disabled={linkBusy} onClick={() => void browse()}>
                  <FolderOpen size={11} /> Browse…
                </button>
                <button className="ws-primary" disabled={linkBusy || !linkPath.trim()}
                        onClick={() => void link(linkPath)}>
                  {linkBusy ? "Checking…" : "Use it"}
                </button>
              </div>
              {linkErr && (
                <p style={{ fontSize: 11, color: WARN, margin: "6px 0 0", lineHeight: 1.45 }}>
                  {linkErr}
                </p>
              )}
            </div>
          )}
        </div>

        {/* ── models: family, then the variants it ships in ───────────── */}
        {([
          ["image", "Image models", "storyboard panels, character sheets, stills"],
          ["video", "Video models", "shots and clips — these are the big downloads"],
          ["audio", "Audio models", "songs, beds and sound effects — the smallest downloads here"],
        ] as const).map(([media, title, sub]) => {
          const fams = media === "image" ? imageFamilies()
            : media === "video" ? videoFamilies() : audioFamilies();
          const runnable = fams.filter((f) => bestVariant(f, budgetGb, ramGb)).length;
          return (
            <div key={media}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "2px 2px 8px" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
                <span style={{ fontSize: 11.5, color: MUTE }}>{sub}</span>
                <div style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 10, color: runnable ? MUTE : WARN }}>
                  {runnable} of {fams.length} run on this machine
                </span>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {fams.map((fam) => {
                  const best = bestVariant(fam, budgetGb, ramGb);
                  const sharedLeft = fam.shared.filter((f) => !installed.has(f.filename));
                  return (
                    <div key={fam.id} className="ws-card" style={{ padding: "11px 12px" }}>
                      <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{fam.name}</span>
                        {/* Rendered from the FLAG, not from `tag` — the flag is
                            what sorts this family to the top of the list, so a
                            hand-written pill saying the same thing could
                            disagree with the order it is standing in. */}
                        {fam.studioDefaultFor && (
                          <Pill tone={best ? OK : MUTE}>studio default</Pill>
                        )}
                        {fam.tag && <Pill tone={best ? OK : MUTE}>{fam.tag}</Pill>}
                        {!best && (
                          <Pill tone={WARN}>{familyBlocker(fam, budgetGb, ramGb)}</Pill>
                        )}
                        <div style={{ flex: 1 }} />
                        {/* A LICENCE THAT LETS US MIRROR USUALLY ASKS SOMETHING BACK.
                            LTX 2.5's permits redistribution and requires that the
                            agreement reach whoever receives the weights — and a first
                            run pulling them off our bucket IS that recipient, so the
                            label becomes a way to read it rather than a word to
                            recognise. Not a link for families that ask nothing. */}
                        {fam.licenseUrl ? (
                          <button
                            type="button" className="mono"
                            onClick={() => { void openExternal(fam.licenseUrl!); }}
                            style={{ fontSize: 10, color: MUTE, background: "none",
                              border: 0, padding: 0, cursor: "pointer",
                              textDecoration: "underline dotted" }}
                            title="Read the licence these weights are distributed under"
                          >{fam.license}</button>
                        ) : (
                          <span className="mono" style={{ fontSize: 10, color: MUTE }}>{fam.license}</span>
                        )}
                      </div>
                      <p style={{ fontSize: 11.5, color: MUTE, margin: "5px 0 0", lineHeight: 1.5 }}>
                        {fam.blurb}
                      </p>
                      {fam.recipe && (
                        <span className="mono" style={{ fontSize: 10, color: MUTE, display: "block", marginTop: 3 }}>
                          {fam.recipe}
                        </span>
                      )}
                      {/* DOWNLOADABLE IS NOT RENDERABLE, and this screen used
                          to imply it was. `localGraphs.RECIPES` has no entry
                          for Krea 2 or H3 — the first needs a node the local
                          installer does not add, the second a dual-VAE audio
                          path nobody has built here — so a variant of either
                          finishes downloading and then never appears in the
                          composer. The reason existed (`localBlocked`) and
                          only ever surfaced on a DIFFERENT screen, after the
                          gigabytes were spent. Said here, where the Get button
                          is, and doubly needed now that the studio defaults
                          lead the list: the top row must not be a trap.

                          A GRAPH BUILDER IS NOT THE ONLY WAY TO RENDER, and
                          asking only for one was wrong about the one family
                          that does it the other way. MMAudio has no
                          `localGraphs` recipe ON PURPOSE — it scores a clip
                          rather than making one, and its tail (mux, publish a
                          derived take, re-anchor the block) is
                          `worker/handlers/v2a.py`, which the desktop runs
                          through the bundled pipeline exactly as the pod does.
                          So `!localRecipe(...)` told somebody with the weights
                          on disk, the packs installed and the engine running
                          that the model "cannot be rendered on this machine",
                          and then named the two screens in this app that
                          render it. `markFor` is the function that already
                          knows — the same verdict every picker shows — and
                          this was the one surface that never asked it. */}
                      {fam.bundled ? (() => {
                        const v = markFor(fam, {
                          status, planner: !!status?.planner, engineUp: !!live,
                        });
                        // `ready` says nothing: the row is renderable and the
                        // variant lines already say what is on disk. `offer`
                        // says nothing either — it is "download it", which is
                        // what the Get button beside it is for.
                        if (!v || v.mark !== "blocked") return null;
                        return (
                          <p style={{ fontSize: 11, color: WARN, margin: "5px 0 0", lineHeight: 1.45 }}>
                            Downloaded, not runnable yet — {v.why}.
                          </p>
                        );
                      })() : !localRecipe(fam.id) && (
                        <p style={{ fontSize: 11, color: WARN, margin: "5px 0 0", lineHeight: 1.45 }}>
                          Download only — {fam.name} cannot be rendered on this machine yet
                          ({NO_RECIPE[fam.id] ?? "no local recipe yet"}). Use it in the cloud,
                          or point your own ComfyUI at the files.
                        </p>
                      )}
                      {/* A family that does a second thing says so where it is
                          listed — H3 renders stills as well as video, which is
                          invisible if it only ever appears under "Video". */}
                      {fam.also && (
                        <p style={{ fontSize: 11, color: OK, margin: "5px 0 0", lineHeight: 1.45 }}>
                          Also: {fam.also}
                        </p>
                      )}

                      {/* The shared files are stated once, at the family, because
                          they are charged once — repeating them on every variant
                          row would imply five copies of a 6.4GB text encoder. */}
                      {fam.shared.length > 0 && (
                        <div className="mono" style={{ fontSize: 10, color: MUTE, marginTop: 7 }}>
                          {/* Each row's size ALREADY includes these — saying
                              "+6.5 GB shared" next to a 9.7 GB row read as if
                              you paid both. */}
                          {sharedLeft.length
                            ? `sizes below include ${fmtSize(sharedLeft.reduce((n, f) => n + f.size_mb, 0))} `
                              + `of shared ${sharedLeft.length === 1 ? "file" : "files"}, `
                              + "fetched once and reused by every variant"
                            : "✓ shared files already on disk — sizes below are what is left"}
                        </div>
                      )}

                      {/* A SHARED file downloading belongs to the family, not
                          to a variant row: it is the encoder all five of them
                          need, and putting a bar on each would read as five
                          downloads. Shown here so the model you were fetching
                          visibly has something in flight, rather than the
                          progress living only in the queue pane. */}
                      {fam.shared.map((f) => {
                        const live = dlFile[f.filename];
                        if (live === undefined || live >= 1) return null;
                        return (
                          <div key={f.filename} style={{ marginTop: 7 }}>
                            <div className="mono" style={{
                              fontSize: 10, color: ACCENT, display: "flex", gap: 6,
                              alignItems: "center", marginBottom: 3,
                            }}>
                              <Loader2 size={10} className="ns-spin" />
                              shared {f.filename} · {Math.round(Math.max(0, live) * 100)}%
                              — every variant below is waiting on this
                            </div>
                            <Bar pct={live} />
                          </div>
                        );
                      })}

                      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 8 }}>
                        {fam.variants.map((v) => {
                          const files = variantFiles(fam, v);
                          const key = `${fam.id}/${v.id}`;
                          return (
                            <VariantRow key={v.id} v={v}
                              size={variantMb(fam, v)}
                              // Remaining counts EVERY partial, shared ones
                              // included — those bytes really are already
                              // fetched whichever variant you pick.
                              remaining={variantRemainingMb(fam, v, installed)
                                - files.reduce((n, f) => n + (partial[f.filename] ?? 0), 0)}
                              // "Resume" is only true of a variant whose OWN
                              // file was interrupted. A part-fetched SHARED
                              // encoder belongs to all five rows, and labelling
                              // them all Resume says five downloads were
                              // stopped when one was — the size column already
                              // tells the honest version.
                              partialMb={v.files.reduce(
                                (n, f) => n + (partial[f.filename] ?? 0), 0)}
                              state={variantInstalled(fam, v, installed) ? "installed"
                                : stateOf(key, files)}
                              pct={pctOf(key, files)} detail={dlNote[key]}
                              budgetGb={budgetGb} ramGb={ramGb} disabled={!canFetch}
                              onGet={() => void get(key, files)} />
                          );
                        })}
                      </div>

                      {/* Adapters belong to the model they adapt. Turbo is the
                          case that matters: model_map's `minimax-h3-turbo` IS
                          this family plus a LoRA, and listing it as its own
                          model would duplicate 32GB of weights in the UI. */}
                      {(() => {
                        // AN ADD-ON SCOPED TO A RUNG IS SHOWN ONLY WITH THAT
                        // RUNG INSTALLED. H3's reference checkpoint comes in
                        // five precisions of which exactly one can load beside
                        // what you downloaded — a `.gguf` will not open in the
                        // stock `UNETLoader` — so listing all five would put
                        // four ~20GB rows on screen that cannot render, and
                        // picking one of them is the whole download wasted.
                        const shown = (fam.addons ?? []).filter((a: FamilyAddon) =>
                          !a.forVariants
                          || a.forVariants.some((id) => {
                            const v = fam.variants.find((x) => x.id === id);
                            return v && variantInstalled(fam, v, installed);
                          }));
                        if (!shown.length) return null;
                        return (
                          <div style={{ marginTop: 9 }}>
                            <div className="mono" style={{ fontSize: 9.5, color: MUTE, marginBottom: 5 }}>
                              ADD-ONS FOR {fam.name.toUpperCase()}
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                              {shown.map((a: FamilyAddon) => (
                                <AddonRow key={a.id} a={a} state={stateOf(a.id, a.files)}
                                  pct={pctOf(a.id, a.files)} detail={dlNote[a.id]}
                                  disabled={!canFetch}
                                  // A PACK IS A SECOND WAY AN ADD-ON CAN BE
                                  // UNUSABLE, and this row never mentioned it.
                                  // `installedAddons` withholds such an adapter
                                  // from the composer's picker, which is right
                                  // and invisible here — so the weights
                                  // downloaded, the pick never appeared, and
                                  // nothing connected the two. An engine
                                  // installed before the pack was added has
                                  // exactly that shape: every file on disk and
                                  // no node to load it.
                                  note={a.needsPack && status?.nodes
                                    && !status.nodes.includes(a.needsPack)
                                    ? `needs ${a.needsPack}, which this engine has not got `
                                      + "— reinstall the engine to add it"
                                    : undefined}
                                  onGet={() => void get(a.id, a.files)} />
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "2px 2px 8px" }}>
            <Zap size={12} style={{ color: MUTE }} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>Post-process</span>
            <span style={{ fontSize: 11.5, color: MUTE }}>
              tools that run after a render, on whatever produced it
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {POST_PROCESS.map((t: PostTool) => (
              <AddonRow key={t.id}
                a={{ id: t.id, name: t.name, blurb: t.blurb, files: t.files,
                     recipe: `~${t.vram_gb}GB to run · ${t.license}` }}
                state={stateOf(t.id, t.files)} pct={pctOf(t.id, t.files)}
                detail={dlNote[t.id]} disabled={!canFetch}
                note={[t.note, t.vram_gb > budgetGb
                  ? `Needs ~${t.vram_gb}GB — more than this machine has.` : null]
                  .filter(Boolean).join(" ")}
                onGet={() => void get(t.id, t.files)} />
            ))}
          </div>
          <p style={{ fontSize: 10.5, color: MUTE, margin: "7px 2px 0", lineHeight: 1.5 }}>
            Frame interpolation and the face detailer fetch their own weights on first
            use, so there is nothing to install for them here.
          </p>
        </div>

        </>}

        {/* The LLM engine. Its own tab because an Ollama model cannot live in a
            ComfyUI model directory — see OllamaSection's own note. */}
        {tab === "llm" && <OllamaSection />}
      {/* TWO ENGINES, ONE TAB. They do the same job and differ on the two
          things that decide between them — the licence and whether a line
          can be acted — so they are read side by side rather than picked
          from a list that states neither. */}
      {tab === "speech" && <><BreezeSection /><QwenSection /></>}

        {/* The one tab that needs no engine at all: a key renders on someone
            else's GPU, so it works on a machine that has downloaded nothing. */}
        {tab === "keys" && <ApiKeysSection />}

        {showLog && tab === "engine" && (
          <div className="ws-card">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span className="ws-mlabel">ENGINE LOG</span>
              <div style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 10, color: MUTE }}>
                {status?.running ? "a cold start takes a minute or two" : "from your own ComfyUI"}
              </span>
            </div>
            <pre className="mono ns-scroll" style={{
              fontSize: 10, lineHeight: 1.5, color: INK, margin: 0,
              maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap",
            }}>{log || "…"}</pre>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

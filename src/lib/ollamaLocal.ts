// A local Ollama, managed from the engine screen — the LLM sibling of
// `comfyLocal.ts`, and the browser half of `src-tauri/src/ollama.rs`.
//
// WHY THESE ARE NOT `engineCatalog` ROWS. That catalogue downloads FILES into
// ComfyUI's model directories. ComfyUI cannot load an Ollama model and Ollama
// cannot read a ComfyUI checkpoint — two engines, two stores, two protocols.
// A "download Qwen3.8" row over there would fetch 17GB nothing could load.
//
// WHY EVERY CALL GOES THROUGH RUST. Ollama sends no CORS headers and the
// webview's origin is `tauri://localhost`, so a browser fetch dies in preflight
// before the daemon sees it — the same wall `comfyLocal` hit on :8188. A pull
// additionally has to outlive the screen that started it: 17GB with nothing
// watching is the lesson the weight-file `Downloads` registry already learned.
//
// WHY THERE IS NO JUDGE ROW HERE. The reviewer's VLM judge is `worker/reviewer/
// vlm.py` — it runs on the pod, against the pod's own Ollama, as one stage of a
// pipeline (ffmpeg sampling, faster-whisper ASR, the shot contract) that has no
// desktop implementation. Listing `qwen3.8:27b` on this screen would be 17GB
// with no consumer on this machine, which is the exact failure this file exists
// to avoid. When a local `take_review` lands, the row lands with it.

import { invoke, invokeStrict, listen, isDesktop, machineBudgetGb, detectHardware } from "./desktop.ts";

export interface OllamaModelInfo {
  name: string;
  size_mb: number;
}

export interface OllamaStatus {
  /** our own binary is on disk, whether or not it is the one running */
  bundled: boolean;
  bin: string | null;
  /** something answers on the port */
  reachable: boolean;
  /** WE started the daemon that is running */
  ours: boolean;
  /** something else holds the port — the user's own Ollama.app or CLI */
  foreign: boolean;
  version: string | null;
  /** OUR binary's version, whoever holds the port. Separate because updating
   *  while the user's own daemon is running changes nothing `version` shows. */
  bundled_version: string | null;
  bundled_version_ok: boolean;
  /** that version carries the qwen3.8 renderer. False is a REASON, not a
   *  warning — see `versionNote` */
  version_ok: boolean;
  min_version: string;
  models: OllamaModelInfo[];
  port: number;
  root: string;
}

export interface OllamaProgress {
  label: string;
  pct: number;
  detail: string;
  /** which model moved, on a pull */
  model: string;
}

/** What a row is for. Only roles with a consumer ON THIS MACHINE appear. */
export type LlmRole = "director";

export interface LocalLlm {
  /** the Ollama tag, exactly as `ollama pull` takes it */
  name: string;
  label: string;
  role: LlmRole;
  /** download size, from the registry manifest rather than the model card */
  size_mb: number;
  /** working set: weights plus the KV cache the daemon pre-allocates. Erring
   *  HIGH costs a row that says "won't fit" on a machine where it might;
   *  erring LOW costs a swap-to-death mid-turn, so it errs high. */
  vram_gb: number;
  blurb: string;
  /** the row a fresh machine should take first — the one this build is
   *  tuned against, so a turn here behaves the way the prompts expect */
  recommended?: boolean;
}

// Sizes measured off the registry manifests (`/v2/<repo>/manifests/<tag>`),
// not read off the model cards — the cards round to whole GB and the 27B's
// card says "18GB" for a 17.7GB set.
export const LOCAL_LLMS: LocalLlm[] = [
  {
    name: "qwen3.8:27b",
    label: "Qwen3.8 27B",
    role: "director",
    size_mb: 17_700,
    vram_gb: 20,
    recommended: true,
    blurb:
      "The model this build's director prompts are written against — 27.3B at " +
      "Q4_K_M, 256K context, tools and thinking. Needs a big machine, and there " +
      "is no smaller Qwen3.8: every tag in the family is 27B.",
  },
  {
    name: "qwen3:8b",
    label: "Qwen3 8B",
    role: "director",
    size_mb: 5_000,
    vram_gb: 7,
    blurb:
      "The laptop option, one generation back. Runs comfortably in 16GB where " +
      "the 27B cannot load at all, and is weaker at long instructions — see " +
      "`localDirectorRules`, which recovers the tool calls it drops.",
  },
  {
    name: "qwen3:14b",
    label: "Qwen3 14B",
    role: "director",
    size_mb: 9_000,
    vram_gb: 11,
    blurb:
      "The middle rung. Wants 32GB to be comfortable; on 16GB it is right at " +
      "the edge of the budget and will lean on swap.",
  },
];

/* ─────────────────────────────────────────────────── pure, and tested ── */

/** Is this tag present on the daemon? Ollama reports `name:tag` and a bare
 *  `name` means `:latest`, so compare on the normalised form — otherwise a
 *  model that IS installed reads as missing and the row offers a second
 *  17GB download. */
export function hasModel(status: OllamaStatus | null, name: string): boolean {
  if (!status) return false;
  const norm = (s: string) => (s.includes(":") ? s : `${s}:latest`).toLowerCase();
  return status.models.some((m) => norm(m.name) === norm(name));
}

/** Why NO row can be used right now — a problem with the daemon rather than
 *  with any one model. Split out from `blockedReason` because it is true of
 *  every row at once, and printing it under each of them repeats a thirty-word
 *  sentence three times where the screen should say it once. */
export function daemonBlocked(status: OllamaStatus | null): string | null {
  if (!status || (!status.reachable && !status.bundled)) {
    return "Ollama is not installed yet";
  }
  if (!status.reachable) return "Ollama is installed but not running";
  if (!status.version_ok) return versionNote(status);
  return null;
}

/** Why THIS row cannot be used — the part that differs per model. */
export function fitBlocked(row: LocalLlm, budgetGb: number): string | null {
  if (budgetGb > 0 && row.vram_gb > budgetGb) {
    return `needs about ${row.vram_gb}GB, this machine can offer about ${budgetGb.toFixed(1)}GB`;
  }
  return null;
}

/** Why this row cannot be used right now, or null when it can.
 *
 *  Order matters: the daemon problems come first because they are true of
 *  every row, and a "won't fit" on a machine with no Ollama at all is advice
 *  about the wrong thing. */
export function blockedReason(
  status: OllamaStatus | null,
  row: LocalLlm,
  budgetGb: number,
): string | null {
  return daemonBlocked(status) ?? fitBlocked(row, budgetGb);
}

/** The sentence a too-old daemon deserves. Written out because the failure it
 *  prevents is silent: a community re-upload may declare no `requires` at all,
 *  so it pulls onto an old daemon and then has no renderer to format chat
 *  with — the system prompt and every tool signature are dropped. */
export function versionNote(status: OllamaStatus | null): string {
  if (!status?.version) return `needs Ollama ${status?.min_version ?? "0.32.12"} or newer`;
  return (
    `Ollama ${status.version} is too old — Qwen3.8's chat formatting comes ` +
    `from a renderer built into ${status.min_version}+. An older daemon pulls ` +
    `the model happily and then misformats every turn.`
  );
}

export type DaemonAction = {
  kind: "install" | "update" | "start" | "stop" | "none";
  label: string;
  note: string | null;
};

/** What to offer about the daemon itself.
 *
 *  Written as one function rather than four conditions in JSX because the
 *  interesting case is easy to get wrong: when the user's OWN Ollama holds the
 *  port and is too old, the screen previously diagnosed the problem and
 *  offered nothing at all. We cannot update their install — an Ollama.app or a
 *  Homebrew copy is theirs — but we CAN put a current one on disk here and say
 *  what to do next, which is the difference between a dead end and a fix.
 */
export function daemonAction(status: OllamaStatus | null): DaemonAction {
  if (!status || (!status.bundled && !status.reachable)) {
    return { kind: "install", label: "Install Ollama", note: null };
  }
  // Theirs, on the port, too old for the models this screen offers.
  if (status.foreign && !status.version_ok) {
    return status.bundled && status.bundled_version_ok
      ? {
          kind: "start",
          label: "Use the newer one",
          note:
            `Ollama ${status.bundled_version} is installed here, but ${status.version} ` +
            `(yours) holds the port. Quit your Ollama, then press this.`,
        }
      : {
          kind: "update",
          label: "Install a newer Ollama",
          note:
            "This installs a current Ollama for the studio and leaves yours alone — " +
            "updating your own copy is not something this app should reach into. " +
            "You will be asked to quit yours before it can be used.",
        };
  }
  // Ours, and stale — only reachable once the pinned version moves.
  if (!status.foreign && status.bundled && !status.bundled_version_ok) {
    return { kind: "update", label: "Update Ollama", note: null };
  }
  if (!status.reachable) return { kind: "start", label: "Start", note: null };
  if (status.ours) return { kind: "stop", label: "Stop", note: null };
  return { kind: "none", label: "", note: null };
}

/** Rows that fit, biggest first — the recommendation is the best one that fits,
 *  the same rule `bestVariant` follows for checkpoints. */
export function bestLlm(budgetGb: number): LocalLlm | null {
  return (
    [...LOCAL_LLMS]
      .filter((m) => m.role === "director")
      .sort((a, b) => b.vram_gb - a.vram_gb)
      .find((m) => budgetGb <= 0 || m.vram_gb <= budgetGb) ?? null
  );
}

export const fmtGb = (mb: number) =>
  mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;

/* ───────────────────────────────────────────────────────── the bridge ── */

export const ollamaStatus = () => invoke<OllamaStatus>("ollama_status");
/** Whatever install or pull is running RIGHT NOW, whoever started it.
 *  The Rust task outlives this screen, so an empty local state means "this
 *  mount has not started anything", never "nothing is happening". */
export const ollamaActive = () => invoke<OllamaProgress[]>("ollama_active");
export const installOllama = () => invokeStrict<OllamaStatus>("install_ollama");
/** Re-download our pinned Ollama over whatever is on disk. Never touches an
 *  Ollama the user installed themselves — see the Rust command's note. */
export const updateOllama = () => invokeStrict<OllamaStatus>("install_ollama", { force: true });
export const startOllama = () => invokeStrict<OllamaStatus>("start_ollama");
export const stopOllama = () => invokeStrict<OllamaStatus>("stop_ollama");
export const ollamaPull = (model: string) => invokeStrict<null>("ollama_pull", { model });
export const ollamaRemove = (model: string) => invokeStrict<null>("ollama_remove", { model });

export const onOllamaProgress = (fn: (p: OllamaProgress) => void) =>
  listen<OllamaProgress>("ollama://progress", fn);

/** One non-streaming turn. `think: false` and the `thinking` fallback both live
 *  in the Rust command — see its doc comment for why saying nothing about
 *  thinking is opting IN. */
export const ollamaChat = (req: {
  system: string;
  messages: { role: string; content: string }[];
  model: string;
}) => invokeStrict<string>("ollama_chat", { req });

/** How much of this machine an LLM may have.
 *
 *  `machineBudgetGb`, NOT `usableVramMb`: the raw probe reports a 16GB M3 as
 *  16GB, and the first version of this used it — so the screen offered that
 *  laptop an 11GB model and said the 27B was 4GB out of reach instead of 10.
 *  Unified memory is shared with the OS; the engine catalogue has always
 *  known that and this now asks the same function. */
export async function llmBudgetGb(): Promise<number> {
  if (!isDesktop()) return 0;
  return machineBudgetGb(await detectHardware());
}

/** The model a local director turn should use: the biggest installed row.
 *  Null when nothing usable is installed, which is what makes the caller fall
 *  back to the pod rather than fail. */
export function installedDirectorModel(status: OllamaStatus | null): string | null {
  if (!status?.reachable || !status.version_ok) return null;
  const usable = LOCAL_LLMS.filter((m) => m.role === "director" && hasModel(status, m.name));
  if (!usable.length) return null;
  return usable.sort((a, b) => b.vram_gb - a.vram_gb)[0].name;
}

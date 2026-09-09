/**
 * Qwen3-TTS on this machine — the desktop bridge, `breezeLocal.ts`'s twin.
 *
 * The same five states and the same one-thing-to-offer rule, because the two
 * engines share a screen and a user should not have to learn two shapes. What
 * differs is stated where it differs: the PAIR of checkpoints, the longer
 * loading window, and the licence — Apache 2.0 here against Breeze's
 * non-commercial weights, which is the whole reason this engine exists beside
 * a working one.
 *
 * `src-tauri/src/qwen.rs` is the other half; `qwenLocal.test.ts` pins the file
 * count and the port against it.
 */
import { invoke, invokeStrict, isDesktop, listen } from "./desktop.ts";

export interface QwenStatus {
  installed: boolean;
  venv: boolean;
  weights_mb: number;
  weights_total_mb: number;
  weights_missing: string[];
  reachable: boolean;
  ours: boolean;
  starting: boolean;
  foreign: boolean;
  device: string | null;
  port: number;
  root: string;
  license: string;
  /** FALSE, and carried in the status rather than discovered as a dropped
   *  delivery note — see `qwen_voice.SUPPORTS_DIRECTION`. */
  supports_direction: boolean;
}

export interface QwenProgress {
  key: string;
  label: string;
  pct: number;
  detail: string;
}

export type QwenAction =
  { kind: "install" | "resume" | "start" | "stop" | "wait" | "none";
    label: string; note: string | null };

/**
 * The one thing to offer, and what to say about it.
 *
 * `breezeAction`'s order, for its reasons: `foreign` first because a server on
 * the port decides everything else, and `starting` before `reachable` because
 * a status that called a loading model "down" would make Start look like it
 * did nothing — which is exactly when a user presses it again. That window is
 * LONGER here, because the server holds two checkpoints rather than one.
 */
export function qwenAction(s: QwenStatus | null): QwenAction {
  if (!s) return { kind: "install", label: "Install Qwen3-TTS", note: null };

  if (s.foreign) {
    return {
      kind: "none", label: "",
      note: `Something else is already serving on port ${s.port}. If that is your own `
        + "Qwen3-TTS, the studio will use it as it is; quit it first to run this one instead.",
    };
  }
  if (s.starting) {
    return {
      kind: "wait", label: "Starting…",
      note: "Loading the voice models — two checkpoints, so the first line takes "
        + "a minute or two, longer on a Mac.",
    };
  }
  if (!s.installed) {
    // A HALF-FETCHED INSTALL IS ITS OWN STATE, and more likely here than for
    // Breeze: this is 9GB across two downloads, so stopping partway through is
    // ordinary. The download resumes at both file and byte granularity.
    const some = s.weights_mb > 0 || s.venv;
    return some
      ? { kind: "resume", label: "Resume the install",
          note: s.weights_missing.length
            ? `${s.weights_missing.length} of ${WEIGHT_FILES} files still to fetch — `
              + "it picks up where it stopped."
            : "The weights are here; the environment is not finished." }
      : { kind: "install", label: "Install Qwen3-TTS", note: null };
  }
  if (!s.reachable) return { kind: "start", label: "Start", note: null };
  if (s.ours) return { kind: "stop", label: "Stop", note: null };
  return { kind: "none", label: "", note: null };
}

/** Files across BOTH checkpoints. Pinned against the Rust `DESIGN_WEIGHTS` +
 *  `CLONE_WEIGHTS` by `qwenLocal.test.ts`, so a file added there cannot leave
 *  this reading "3 of 22" about a set of twenty-three. */
export const WEIGHT_FILES = 22;

/** GB still to fetch, for the install button's own copy. */
export const remainingGb = (s: QwenStatus | null): number =>
  s ? Math.max(0, s.weights_total_mb - s.weights_mb) / 1024 : 0;

/**
 * Why Qwen3-TTS cannot speak here, or null.
 *
 * Used by the model picker's mark, so the sentence a blocked row shows is the
 * same one the Speech tab would give — one place decides, the rule
 * `desktopRows` follows for a bundled family.
 */
export function qwenBlocked(s: QwenStatus | null): string | null {
  if (!s) return "install Qwen3-TTS in the engine window's Speech tab";
  if (s.reachable) return null;
  if (!s.installed) {
    return `install Qwen3-TTS in the engine window's Speech tab `
      + `(${remainingGb(s).toFixed(1)}GB, Apache 2.0)`;
  }
  if (s.starting) return "Qwen3-TTS is still loading — give it a moment";
  return "start Qwen3-TTS in the engine window's Speech tab";
}

/* ── the bridge ─────────────────────────────────────────────────────────── */

export const qwenStatus = () => invoke<QwenStatus>("qwen_status");

export const qwenActive = () => invoke<QwenProgress[]>("qwen_active");

/**
 * `cdnBase` is `VITE_B2_CDN_BASE` — the studio's own mirror. Rust probes the
 * set index there and falls back to HuggingFace per checkpoint, so a mirror
 * that carries one and not the other still serves the one it has.
 */
export const installQwen = (opts: { force?: boolean; cdnBase?: string } = {}) =>
  invokeStrict<void>("install_qwen", {
    force: opts.force ?? false,
    cdnBase: opts.cdnBase ?? null,
  });

export const startQwen = () => invokeStrict<void>("start_qwen");
export const stopQwen = () => invokeStrict<void>("stop_qwen");

/** Stop OUR child before a render — see `qwen.rs::qwen_park`. */
export const qwenPark = () => invoke<boolean>("qwen_park");

export const qwenEnsureUp = (waitS?: number) =>
  invokeStrict<boolean>("qwen_ensure_up", { waitS: waitS ?? null });

export const onQwenProgress = (cb: (p: QwenProgress) => void) =>
  listen<QwenProgress[]>("qwen://progress", (ps) => ps.forEach(cb));

export const qwenReachable = async (): Promise<boolean> =>
  isDesktop() ? Boolean((await qwenStatus())?.reachable) : false;

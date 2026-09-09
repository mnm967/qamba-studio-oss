/**
 * Breeze TTS 2 on this machine — the TypeScript half of `src-tauri/breeze.rs`.
 *
 * Shaped like `ollamaLocal.ts`, deliberately: a typed mirror of the Rust
 * status, a PURE action table the screen only dispatches, and thin bridge
 * calls. The action table is the part worth having as a function — the states
 * that matter are the ones easy to get wrong in JSX (something else holding
 * the port; our own child loading a 7.7GB model and not answering yet), and a
 * screen that renders those as "not installed" offers the wrong fix.
 */
import { invoke, invokeStrict, isDesktop, listen } from "./desktop.ts";

export interface BreezeStatus {
  installed: boolean;
  code: boolean;
  venv: boolean;
  weights_mb: number;
  weights_total_mb: number;
  weights_missing: string[];
  reachable: boolean;
  /** ours AND answering */
  ours: boolean;
  /** our child is alive and the model is still loading */
  starting: boolean;
  /** something else holds the port — never stopped from here */
  foreign: boolean;
  device: string | null;
  rev: string;
  port: number;
  root: string;
  license: string;
}

export interface BreezeProgress {
  label: string;
  pct: number;
  detail: string;
  key: string;
}

export type BreezeAction =
  { kind: "install" | "resume" | "start" | "stop" | "wait" | "none";
    label: string; note: string | null };

/**
 * The one thing to offer, and what to say about it.
 *
 * Order matters. `foreign` is checked before `installed` because a server on
 * the port is the fact that decides everything else — starting a second one
 * would take a port we do not own and load 7.7GB beside somebody else's copy.
 * `starting` is checked before `reachable` because a status that called a
 * loading model "down" would make Start look like it did nothing, which is
 * exactly when a user presses it again.
 */
export function breezeAction(s: BreezeStatus | null): BreezeAction {
  if (!s) return { kind: "install", label: "Install Breeze TTS 2", note: null };

  if (s.foreign) {
    return {
      kind: "none", label: "",
      note: `Something else is already serving on port ${s.port}. If that is your own `
        + "Breeze, the studio will use it as it is; quit it first to run this one instead.",
    };
  }
  if (s.starting) {
    return {
      kind: "wait", label: "Starting…",
      note: "Loading the voice model — 30 to 60 seconds the first time, longer on a Mac.",
    };
  }
  if (!s.installed) {
    // A HALF-FETCHED INSTALL IS ITS OWN STATE. "Install" over 6GB already on
    // disk reads as starting again from nothing, and the download resumes at
    // both file and byte granularity — so the label says so.
    const some = s.weights_mb > 0 || s.code || s.venv;
    return some
      ? { kind: "resume", label: "Resume the install",
          note: s.weights_missing.length
            ? `${s.weights_missing.length} of ${WEIGHT_FILES} files still to fetch — `
              + "it picks up where it stopped."
            : "The weights are here; the environment is not finished." }
      : { kind: "install", label: "Install Breeze TTS 2", note: null };
  }
  if (!s.reachable) return { kind: "start", label: "Start", note: null };
  if (s.ours) return { kind: "stop", label: "Stop", note: null };
  return { kind: "none", label: "", note: null };
}

/** How many files the weight set has. Pinned against the Rust `WEIGHTS` by
 *  `breezeLocal.test.ts`, so a file added there cannot leave this reading
 *  "3 of 12" about a set of thirteen. */
export const WEIGHT_FILES = 12;

/** GB still to fetch, for the install button's own copy. */
export const remainingGb = (s: BreezeStatus | null): number =>
  s ? Math.max(0, s.weights_total_mb - s.weights_mb) / 1024 : 0;

/**
 * Why Breeze cannot speak here, or null.
 *
 * Used by the model picker's mark, so the sentence a blocked row shows is the
 * same one the Speech tab would give — one place decides, the same rule
 * `desktopRows` follows for a bundled family.
 */
export function breezeBlocked(s: BreezeStatus | null): string | null {
  if (!s) return "install Breeze TTS 2 in the engine window's Speech tab";
  if (s.reachable) return null;
  if (!s.installed) {
    return `install Breeze TTS 2 in the engine window's Speech tab `
      + `(${remainingGb(s).toFixed(1)}GB, non-commercial weights)`;
  }
  if (s.starting) return "Breeze is still loading — give it a moment";
  return "start Breeze TTS 2 in the engine window's Speech tab";
}

/* ── the bridge ─────────────────────────────────────────────────────────── */

export const breezeStatus = () =>
  invoke<BreezeStatus>("breeze_status");

export const breezeActive = () =>
  invoke<BreezeProgress[]>("breeze_active");

/**
 * Install (or resume).
 *
 * `cdnBase` is the studio's mirror, and Rust does the resolving: it reads
 * `engine/sets/index.json` once and takes EVERY file from there or none of
 * them. Passing a base rather than twelve URLs keeps the file list in one
 * place — Rust's, which is the copy that must exist at install time — and
 * means a bumped revision needs no change here at all.
 */
export const installBreeze = (opts: { force?: boolean; cdnBase?: string } = {}) =>
  invokeStrict<void>("install_breeze", {
    force: !!opts.force,
    cdnBase: opts.cdnBase
      ?? (import.meta as unknown as { env?: Record<string, string> })
        .env?.VITE_B2_CDN_BASE ?? null,
  });

export const startBreeze = () => invokeStrict<void>("start_breeze");
export const stopBreeze = () => invokeStrict<void>("stop_breeze");

/** Stop OUR child before a ComfyUI render — 8.5GB it does not need to hold. */
export const breezePark = () => invoke<boolean>("breeze_park");

/** Bring it back for a line. Throws with the reason when it cannot. */
export const breezeEnsureUp = (waitS?: number) =>
  invokeStrict<boolean>("breeze_ensure_up", { waitS: waitS ?? null });

export const onBreezeProgress = (cb: (p: BreezeProgress) => void) =>
  listen<BreezeProgress>("breeze://progress", cb);

/** Cheap enough to poll, and null off the desktop. */
export const breezeReachable = async (): Promise<boolean> =>
  isDesktop() ? !!(await breezeStatus())?.reachable : false;

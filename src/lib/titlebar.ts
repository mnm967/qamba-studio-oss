// The macOS traffic lights are drawn ON TOP of the page, and nothing in the
// DOM knows it.
//
// `tauri.conf.json` asks for `titleBarStyle: "Overlay"` + `hiddenTitle`, which
// is what makes the desktop window one continuous dark surface instead of the
// app sitting under a native grey bar. The cost is that the close / minimise /
// zoom buttons float over the top-left of the webview at their standard
// positions — so any chrome that starts at the left edge is UNDERNEATH them.
// `.ws-top` puts the NS mark at 16px, i.e. directly beneath the minimise
// button, which is the overlap this module exists to remove.
//
// It is published as a CSS variable rather than a per-component check for the
// same reason `isDesktop()` is one object: a surface opts in with one `max()`
// and never learns what platform it is on. The value is 0 everywhere except a
// macOS desktop build — the web build has no overlay at all, and Windows and
// Linux draw their window controls on the RIGHT, where none of our chrome
// starts.
//
// WHICH SURFACES OPT IN is a real decision, not a sweep: only the ones that
// actually touch the window's left edge. `.ws-top` does, and so does a
// full-width `V2Shell` bar. The legacy studio (`.app`, max-width 440) and a
// narrow `.v2` (max-width 640) are centred columns inside a 1024px-minimum
// window, so they clear the buttons by hundreds of pixels — padding them would
// indent a back arrow for nothing.

// `.ts` on purpose: `node --test` strips types rather than compiling them and
// does not resolve an extensionless relative import, so a tested module that
// imports another src module has to spell the extension (tsconfig sets
// `allowImportingTsExtensions`; Vite resolves it too).
import { isDesktop } from "./desktop.ts";

/**
 * How much room the buttons need, in CSS px.
 *
 * The standard macOS traffic lights are 12pt wide on 20pt centres starting at
 * x=20, so the zoom button's right edge lands at 66; the rest is breathing
 * room. Tauri's `Overlay` only makes the titlebar transparent — unlike
 * Electron's `trafficLightPosition` it cannot move them — so this is a fixed
 * geometry, not a guess that needs measuring per machine.
 */
export const TRAFFIC_LIGHT_INSET_PX = 78;

/** The variable every opted-in surface reads. */
export const INSET_VAR = "--titlebar-inset";

/** True when the page is running in a webview on macOS. `navigator.platform`
 *  is deprecated but still the most direct answer; the user-agent string is
 *  the fallback and carries "Macintosh" in every WKWebView. */
export function isMacUA(nav: { platform?: string; userAgent?: string } = navigator): boolean {
  return /^Mac/i.test(nav.platform ?? "") || /Macintosh|Mac OS X/.test(nav.userAgent ?? "");
}

/**
 * The whole rule, as a pure function so it can be tested without a window.
 *
 * Fullscreen is the one state that takes the gutter back: macOS hides the
 * buttons entirely there (they slide in with a native overlay bar that covers
 * our top bar anyway), so holding the space would leave a permanent 78px hole
 * to the left of the wordmark.
 */
export function titlebarInset(o: {
  desktop: boolean; mac: boolean; fullscreen?: boolean;
}): number {
  if (!o.desktop || !o.mac || o.fullscreen) return 0;
  return TRAFFIC_LIGHT_INSET_PX;
}

/** Write the inset onto the document. Separated from the decision above so a
 *  test can check the arithmetic and the caller can re-apply on a state change. */
export function applyTitlebarInset(px: number, root: HTMLElement = document.documentElement): void {
  root.style.setProperty(INSET_VAR, `${px}px`);
  // An attribute as well as the variable: a rule that needs to do more than
  // move padding (hiding a divider, say) has something to hang off, and it is
  // what a devtools inspection shows first.
  if (px > 0) root.setAttribute("data-titlebar", "overlay");
  else root.removeAttribute("data-titlebar");
}

/** Ask the window whether it is fullscreen. Needs no capability change:
 *  `allow-is-fullscreen` is in `core:window:default`, which `core:default`
 *  already grants in capabilities/default.json (checked against the tauri
 *  2.11 crate's own permission reference, not assumed).
 *
 *  Returns false — the state that KEEPS the gutter — whenever the answer
 *  cannot be had: the mock bridge does not fake this namespace, and an inset
 *  present when it needn't be is a small gap, where a missing one is the
 *  overlap being fixed. */
async function isFullscreen(): Promise<boolean> {
  try {
    const w = (typeof window !== "undefined" && window.__TAURI__?.window) || null;
    return (await w?.getCurrentWindow().isFullscreen()) ?? false;
  } catch {
    return false;
  }
}

/**
 * Set the inset now and keep it right afterwards.
 *
 * Fullscreen has no dedicated event, so this rides the window's own resize
 * signal — entering or leaving fullscreen always resizes. Everything degrades:
 * with no `event` namespace (the web build, the mock) the inset is simply
 * applied once, which is correct for every case except a fullscreen toggle.
 */
export async function watchTitlebar(): Promise<() => void> {
  const desktop = isDesktop();
  const mac = isMacUA();
  const refresh = async () =>
    applyTitlebarInset(titlebarInset({ desktop, mac, fullscreen: await isFullscreen() }));

  if (!desktop || !mac) { applyTitlebarInset(0); return () => {}; }

  // Apply the un-fullscreened value synchronously first: the probe is a round
  // trip through IPC, and a top bar that jumps 78px on load is worse than one
  // that occasionally holds the gutter for a frame too long.
  applyTitlebarInset(TRAFFIC_LIGHT_INSET_PX);
  await refresh();

  try {
    const un = await window.__TAURI__?.event?.listen("tauri://resize", () => { void refresh(); });
    return () => un?.();
  } catch {
    return () => {};
  }
}

// What this machine can render right now.
//
// Two questions with different answers and different costs: what is INSTALLED
// (a filesystem walk in Rust — cheap, changes when a download lands) and
// whether the engine is LISTENING (an HTTP round trip that can hang for the
// timeout — and which is false for minutes after a start while ComfyUI loads).
// Keeping them apart is what lets the picker offer a model and say "start the
// engine" instead of hiding it, which reads as the download having failed.
//
// Shared module-level, because several surfaces ask at once (the composer, the
// engine modal, the queue) and each mounting its own poller would mean three
// `engine_status` walks a tick.
import { useEffect, useMemo, useState } from "react";
import { engineStatus, isDesktop, type EngineStatus } from "../lib/desktop";
import { pingComfy, DEFAULT_COMFY, type ComfyStatus } from "../lib/comfyLocal";
import { engineTree, localBlocked, localModelRows, localOfferRows } from "../lib/localModels";
import { desktopRenderModels, plannerInstalled,
         type DesktopRenderModel } from "../lib/desktopPlanner";
import type { ModelCatalogRow } from "../lib/db/types";

const STATUS_MS = 8000;
/** The reachability probe is the expensive one, and an engine does not start
 *  or stop on its own — so it is asked less often than the file walk. */
const PING_MS = 20000;

interface Shared {
  status: EngineStatus | null;
  comfy: ComfyStatus | null;
  /** `desktop_render_models` — the MODEL MAP's view, which is a different
   *  question from `status.files` and answers it for the bundled pipeline.
   *  Null until the first call lands, and read as "nobody has asked". */
  render: DesktopRenderModel[] | null;
  /** the bundled pipeline's Python is on disk. Not the same as `installed`:
   *  a machine that took "Utilities only", or linked its own ComfyUI, has one
   *  and not the other. */
  planner: boolean;
  at: number;
}
let shared: Shared = { status: null, comfy: null, render: null, planner: false, at: 0 };
const subs = new Set<(s: Shared) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let pinged = 0;

function publish(next: Partial<Shared>) {
  shared = { ...shared, ...next, at: Date.now() };
  for (const fn of subs) fn(shared);
}

async function refresh(force = false) {
  if (!isDesktop()) return;
  const s = await engineStatus().catch(() => null);
  publish({ status: s });
  // Both are Rust calls over data this poll already went to disk for — the
  // map is one file read and a stat per weight, the planner check two
  // `exists`. Kept on this timer rather than in their own so a picker asking
  // "can this machine draw a sheet" costs no extra IPC per render.
  const [render, planner] = await Promise.all([
    desktopRenderModels().catch(() => null),
    plannerInstalled().catch(() => false),
  ]);
  publish({ render, planner });
  if (force || Date.now() - pinged > PING_MS) {
    pinged = Date.now();
    publish({ comfy: await pingComfy(DEFAULT_COMFY) });
  }
}

export interface LocalEngine {
  /** the desktop shell, i.e. is any of this even possible */
  desktop: boolean;
  status: EngineStatus | null;
  /** installed AND listening — the only state in which a render can start */
  ready: boolean;
  /** installed, whoever started it */
  running: boolean;
  device: string | null;
  /** one catalog-shaped row per installed, renderable variant — PLUS one
   *  greyed download offer per family whose weights are not here yet, so a
   *  picker says what this machine could run and not only what it has. */
  rows: ModelCatalogRow[];
  /** the IMAGE entries of `model_map.desktop.json`, with what each is missing.
   *  Null before the first answer — see `markDesktopImageRows`, which reads
   *  that as "nobody has asked" rather than as "nothing is installed". */
  imageModels: DesktopRenderModel[] | null;
  /** the VIDEO entries of the same map — what this machine could render a
   *  BLOCK with. Same null contract, and read by the wizard's model picker,
   *  which is polled rather than asked once: a download landing while step 4
   *  is open should move its row into the local section on the next tick. */
  videoModels: DesktopRenderModel[] | null;
  /** the bundled pipeline's Python is installed */
  planner: boolean;
  /** downloaded families this app cannot drive yet, and why */
  blocked: { name: string; why: string }[];
  reload: () => void;
}

export function useLocalEngine(): LocalEngine {
  const [s, setS] = useState<Shared>(shared);

  useEffect(() => {
    if (!isDesktop()) return;
    subs.add(setS);
    if (!shared.at) void refresh(true);
    timer ??= setInterval(() => void refresh(), STATUS_MS);
    return () => {
      subs.delete(setS);
      if (!subs.size && timer) { clearInterval(timer); timer = null; }
    };
  }, []);

  // WHAT RUNS NOW, THEN WHAT A DOWNLOAD WOULD ADD — one list, in that order.
  //
  // Concatenated here rather than inside `localModelRows` because the two
  // answer different questions and one of them is asked by things that are not
  // pickers: `localModelRows` is "what can this machine render", and its own
  // tests pin it exactly. `rows` is the PICKER-facing list, and a picker that
  // showed only the downloaded half read as a build with two models in it —
  // see `localOfferRows`.
  //
  // THE ORDER IS THE CONTRACT for the surfaces that do not sort (the context
  // panel, project settings, the new-project form): they render this array as
  // it stands, so anything that runs has to be in front of anything that would
  // have to be fetched. The ones that DO sort get the same answer from
  // `enabled` and `sort`.
  const rows = useMemo(
    () => [...localModelRows(s.status), ...localOfferRows(s.status)], [s.status]);
  const blocked = useMemo(() => localBlocked(s.status), [s.status]);
  // Memoised for `rows`' reason: a consumer that useMemos on this list would
  // otherwise recompute on every render of every surface that asks.
  const imageModels = useMemo(
    () => (s.render ? s.render.filter((m) => (m.kind ?? "video") === "image") : null),
    [s.render]);
  // A build older than the `kind` field reports none, so an absent one is read
  // as the section it was: `desktop_render_models` carried video rows alone.
  const videoModels = useMemo(
    () => (s.render ? s.render.filter((m) => (m.kind ?? "video") === "video") : null),
    [s.render]);

  return {
    desktop: isDesktop(),
    status: s.status,
    // `engineTree`, not `installed`: a LINKED ComfyUI that is listening is
    // every bit as ready to render — the graph goes to :8188 either way, and
    // gating on our own install made the timeline's extend modal call a live
    // engine "not running".
    ready: engineTree(s.status) && !!s.comfy?.reachable,
    running: !!s.comfy?.reachable,
    device: s.comfy?.device ?? null,
    rows,
    imageModels,
    videoModels,
    planner: s.planner,
    blocked,
    reload: () => void refresh(true),
  };
}

/** Force a refresh from outside React — the engine modal calls it after an
 *  install or a download finishes, so the composer's list is right on the next
 *  tick rather than up to eight seconds later. */
export const refreshLocalEngine = () => void refresh(true);

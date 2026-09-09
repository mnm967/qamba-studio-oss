// CAN THIS MACHINE RUN THIS RENDER — asked before the click, not after it.
//
// A cut render is `tl_render`, which the bundled Python and this machine's own
// ffmpeg perform (`plan_cli.KINDS`), plus whatever ComfyUI passes the post
// chain adds. Every refusal here is one the worker or `enqueueJob` already
// makes; what this adds is saying so BEFORE the render is queued, and — where
// the fix is the user's own — a button onto the screen that performs it.
//
// It descends from a PICKER: the studio build this was forked from could send
// a cut to its own render pod instead, so this module chose between two planes
// and reported the reason each one could not be picked. There is one plane
// now, so the choice is gone and the REASON is what was worth keeping — which
// is the half that was doing the work anyway.
//
// PURE, so every case is a test rather than a machine. The facts it reasons
// over are gathered by `renderFacts`, which is the one function here that
// touches the world.
import {
  gapLines, gapSentence, postLocalGaps, type GapLine, type Inventory, type OpGap,
} from "./postLocal.ts";
import { activeOps, type PostChain, type PostOptions } from "./postChain.ts";

export interface RenderBlock {
  why: string;
  /** An engine-window tab that would fix it, when one would. A reason with
   *  nowhere to go is the refusal `rowBlocked` exists to end. */
  fix?: "engine" | "models";
  /** What is missing, one line each — named because "some models are missing"
   *  sends somebody to a Models tab of forty rows to work out which. A line
   *  that is not `fixable` is there to be READ (turn the pass off); it has no
   *  download behind it. */
  needs?: GapLine[];
}

/** What a decision needs to know about this machine. */
export interface RenderFacts {
  /** This build has the desktop bridge. Off it there is no worker at all —
   *  `startLocalWorker` returns without starting in a browser tab. */
  desktop: boolean;
  /** The engine's own Python and this build's bundled worker source are on
   *  disk. `tl_render` runs through them. */
  planner: boolean;
  /** ffmpeg AND ffprobe are reachable by a child we spawn. `tl_render` is in
   *  `plan_cli.FFMPEG_KINDS`; without it the job dies inside `subprocess`. */
  ffmpeg: boolean;
  /** The local ComfyUI is answering right now. */
  engineUp: boolean;
  /** The resolved chain drives ComfyUI, so the engine is a precondition
   *  rather than a nicety. A chain of ffmpeg-only passes (or none) needs none
   *  of it, and gating on it there would refuse a cut render on a laptop that
   *  has never installed an engine and does not need one. */
  needsEngine: boolean;
  /** Per pass: the weights and node packs this machine is missing for the
   *  chain as it stands. See postLocal.ts — empty is the common case, and a
   *  chain of ffmpeg-only passes can never fill it. */
  postGaps: OpGap[];
}

/**
 * Why this render cannot start, or null.
 *
 * ORDER IS THE ORDER OF THE FIX. The deepest missing prerequisite is named
 * first, so the sentence is the next thing to do rather than the last thing
 * that failed.
 */
export function renderBlock(f: RenderFacts): RenderBlock | null {
  if (!f.desktop) {
    return { why: "renders run in the desktop app, on your own machine — this is the web build" };
  }
  // Both sentences are `renderableHere`'s own, so a refusal reads the same
  // wherever it is met.
  if (!f.planner) {
    return { why: "the local engine's Python is not installed", fix: "engine" };
  }
  if (!f.ffmpeg) {
    return {
      why: "ffmpeg is not installed — the engine window has it under “Utilities only”",
      fix: "engine",
    };
  }
  if (f.needsEngine && !f.engineUp) {
    return {
      why: "the finishing passes drive ComfyUI and the local engine is not running",
      fix: "engine",
    };
  }
  // LAST, because it is the only one that needs the engine to have ANSWERED —
  // a node gap is not reportable until the class list has been read, and the
  // check above is what guarantees it has been. Every pass that has a
  // requirement is a ComfyUI pass, so the two conditions cannot come apart.
  if (f.postGaps.length) {
    const lines = gapLines(f.postGaps);
    return {
      why: gapSentence(f.postGaps),
      // ONLY when something can actually be downloaded. A chain blocked on a
      // node pack this build does not install has no button that helps, and
      // offering one is the dead click `rowBlocked` refuses to ship.
      ...(lines.some((l) => l.fixable) ? { fix: "models" as const } : {}),
      needs: lines,
    };
  }
  return null;
}

/* ── answered from the machine ──────────────────────────────────────────── */

/**
 * The engine's class names, cached.
 *
 * `/object_info` is MULTI-MEGABYTE — its own doc comment says "fetch once and
 * hold it" — and this is re-asked on every toggle of the post card, because
 * the chain is what decides which classes matter. The answer cannot change
 * without a node pack install AND an engine restart, so a short TTL is free:
 * a burst of toggles pays one fetch, and a genuine restart is picked up
 * within a minute. `worker.py`'s `_has_node` makes the same trade for the
 * same reason.
 *
 * A FAILED FETCH IS NOT CACHED. "I could not ask" must not harden into "your
 * engine has none of these" for a minute.
 */
const NODES_TTL_MS = 60_000;
let nodeCache: { at: number; set: ReadonlySet<string> } | null = null;

async function installedNodes(): Promise<ReadonlySet<string> | null> {
  if (nodeCache && Date.now() - nodeCache.at < NODES_TTL_MS) return nodeCache.set;
  try {
    const { getInstalledNodes, DEFAULT_COMFY } = await import("./comfyLocal.ts");
    const set = await getInstalledNodes(DEFAULT_COMFY);
    nodeCache = { at: Date.now(), set };
    return set;
  } catch {
    return null;
  }
}

/** Test seam, and the way a node-pack install is picked up at once rather than
 *  within the TTL. */
export function forgetInstalledNodes(): void { nodeCache = null; }

/**
 * `renderBlock`'s inputs, gathered.
 *
 * Separate from the pure half for `planLanesHere`'s reason: every field is a
 * lookup, and doing them at the call site is how the CARD and the QUEUE come
 * to answer differently.
 *
 * The lazy imports are not decoration: `comfyLocal` reaches the data client
 * through `db/customWorkflows`, an extensionless specifier that
 * `node --test`'s strip-only loader cannot resolve — while the decisions above
 * are exactly what its tests need to reach.
 */
export async function renderFacts(opts: {
  /** The chain as it stands in the modal, per clip — the passes it would run
   *  are what decide both whether the engine matters and which weights do. */
  chains: (PostChain | null | undefined)[];
  opts: PostOptions;
}): Promise<RenderFacts> {
  // The union of every pass any clip would run. A pass one clip has turned on
  // is a pass this machine has to be able to perform, so the union — not the
  // project default — is the question.
  const ops = [...new Set(opts.chains.flatMap((c) => activeOps(c)))];
  const { POST_OP } = await import("./postChain.ts");
  const needsEngine = ops.some((op) => POST_OP[op]?.gpu);

  const { engineStatus, isDesktop } = await import("./desktop.ts");
  if (!isDesktop()) {
    return {
      desktop: false, planner: false, ffmpeg: false, engineUp: false,
      needsEngine, postGaps: [],
    };
  }
  const { plannerInstalled, desktopRenderModels } = await import("./desktopPlanner.ts");
  const [planner, st, rows] = await Promise.all([
    plannerInstalled(), engineStatus(), desktopRenderModels(),
  ]);
  // ASKED ONLY WHEN IT MATTERS. A ping is a request, and a chain with no
  // ComfyUI pass has no use for the answer.
  let engineUp = false;
  let nodes: ReadonlySet<string> | null = null;
  if (needsEngine) {
    const { pingComfy, DEFAULT_COMFY } = await import("./comfyLocal.ts");
    engineUp = (await pingComfy(DEFAULT_COMFY)).reachable;
    // THE ENGINE'S OWN CLASS LIST, not the directory names under
    // `custom_nodes`. `_require_nodes` checks CLASSES, so this is the same
    // question the render will ask — where a directory name is a guess that
    // is wrong for anyone who renamed a pack or installed it under an alias,
    // and a false refusal there would take the render away for no reason.
    // NULL when the engine is down, which `postLocalGaps` reads as "not
    // asked" rather than "absent".
    if (engineUp) nodes = await installedNodes();
  }
  const inv: Inventory = {
    files: new Set(st?.files ?? []),
    nodes,
    models: new Map(rows.map((r) => [r.key, { ready: r.ready, missing: r.missing }])),
  };
  return {
    desktop: true,
    planner,
    ffmpeg: !!st?.ffmpeg,
    engineUp,
    needsEngine,
    postGaps: postLocalGaps(ops, opts.opts, inv),
  };
}

// The studio's own pipeline, run on this machine.
//
// WHAT THIS BUYS: the pod stops being mandatory. It began as the PLANNER —
// `plan_storyboard` was an `llm_task` on `lane: "llm"`, which only the pod
// claims, so a desktop with a local engine could render and could not PLAN —
// and it is now every job kind `plan_cli.KINDS` allows: the episode's block
// plan, voice, audio slicing, assembly, the cut render.
//
// AND IT REACHES A LOCAL PROJECT. `sb.py` speaks PostgREST; a local project's
// rows are a JSON file this webview owns. They meet over a loopback listener
// (`dbproxy.rs` + `localRest.ts`) that this module points the child at, with
// `QAMBA_MEDIA_ROOT` naming the project's own media folder so `media.b2_put`
// becomes a file copy. Neither `sb` nor `media` knows the difference.
//
// IT IS THE SAME PYTHON, not a port. See `src-tauri/src/planner.rs` and
// `worker/plan_cli.py`: `storyplan.py` imports json/math/re, `llm.py` needs no
// boto3, and `install_engine` already put a private CPython on disk. A
// TypeScript reimplementation of the most rule-dense module in this repo would
// be the worst twin in it.
//
// THE KEY NEVER COMES BACK THROUGH HERE. This module says WHICH providers the
// plan may spend and Rust reads those keys from the keychain itself, straight
// into the child's environment — the same "used in Rust, never handed to
// JavaScript" shape every other BYOK path has.
import { engineStatus, invoke, invokeStrict, isDesktop } from "./desktop.ts";
import { LOCAL_ENGINES } from "./speechProviders.ts";
import { byokBackendProvider } from "./byokChat.ts";
import { hasKey, refreshByok } from "./byok.ts";
import { BYOK_PROVIDERS } from "./byokProviders.ts";
import { breezeReachable } from "./breezeLocal.ts";
import { qwenReachable } from "./qwenLocal.ts";
import type { Job } from "./db/types.ts";

export interface PlanOutcome {
  ok: boolean;
  error: string | null;
  log: string;
}

/** Can this machine run a pipeline job at all — engine Python on disk, source
 *  bundled? */
export async function plannerInstalled(): Promise<boolean> {
  if (!isDesktop()) return false;
  return (await invoke<boolean>("planner_ready")) ?? false;
}

/**
 * The job kinds this build's Python can execute here.
 *
 * MIRRORS `plan_cli.KINDS`, and `desktopJobs.test.ts` pins the two against
 * each other by parsing both — a kind the browser routes to `local` that the
 * Python refuses is a job that queues, is claimed, and dies with a sentence
 * about the render pod. `image_gen`, `clip_gen` and `byok_gen` are absent
 * because the local worker runs those in TypeScript already; every other
 * ComfyUI-driving kind is absent because it resolves its graph against the
 * POD's model map.
 */
export const PY_KINDS: ReadonlySet<string> = new Set([
  "llm_task", "embed", "launch_render", "tts", "voice_clone", "asset_ingest",
  "audio_slice", "assemble_take", "assemble_cut", "patch_splice",
  "clip_render", "tl_render", "frame_extract", "block_from_clip",
  // A block's per-shot panels laid into one numbered board — PIL over
  // pictures already drawn, no engine.
  "sheet_compose",
  // The ones that drive ComfyUI. Possible at all because the desktop has a
  // MODEL MAP of its own now (`infra/model_map.desktop.json`, generated from
  // the pod's and pruned to what the engine window can download), so the same
  // `resolve.py` parameterises the same templates by files this machine has.
  "master_pass", "patch_flf", "music_gen", "sfx_gen",
  // A REFERENCE SHEET IS NOT ONE PICTURE, which is why this is here and
  // `clip_gen` is not: `handlers/images.py` composes the prompt for the family
  // that is FINALLY chosen, resolves the late-bound `anchors` a plan's own
  // sheets hang on (a body sheet composes over a face plate that has not
  // rendered when the job is written) and attaches the result to a bible role.
  // `localRender` renders a prompt and has none of that. A `local:` id still
  // goes there — `localWorker`'s `pickedLocal` split — because that id space
  // is `engineCatalog`'s and `resolve.py` has never heard of one.
  "image_gen",
  // Video -> audio: scores a clip already on the timeline by watching it.
  // The only kind here whose INPUT is a video, and the reason the engine
  // installer adds VideoHelperSuite beside the MMAudio nodes.
  "v2a_gen",
  // A whole reference sheet as ONE H3 take — every view of a character or a
  // location from one pass, which is what `image_gen` structurally cannot do
  // (four independent renders of a location come back as four crops of one
  // frontal view, and a six-view turnaround grid is a composition the image
  // models refuse). It resolves a VIDEO key, so `sheetsHere` asks the video
  // map about it rather than the image one.
  "orbit_sheet",
]);

/** Those that submit a graph to ComfyUI, so the worker pings the engine before
 *  claiming one. Mirrors `plan_cli.RENDER_KINDS`. */
export const RENDER_KINDS: ReadonlySet<string> = new Set([
  "master_pass", "patch_flf", "music_gen", "sfx_gen", "v2a_gen", "image_gen",
  "orbit_sheet",
]);

/** Those of them that shell out to ffmpeg, which the engine installer does not
 *  put on the machine. Reported before a job is queued rather than discovered
 *  inside `subprocess` after it has been claimed. */
export const FFMPEG_KINDS: ReadonlySet<string> = new Set([
  "asset_ingest", "audio_slice", "assemble_take", "assemble_cut",
  "patch_splice", "clip_render", "tl_render", "frame_extract",
  "block_from_clip", "tts",
  // A render needs it too: every take is trimmed of its warmup frames and
  // muxed before it is published. `v2a_gen` muxes its new track onto the
  // take with `-c:v copy`, which is the whole reason the picture survives.
  "master_pass", "patch_flf", "music_gen", "sfx_gen", "v2a_gen",
]);

/**
 * Whether this job needs Breeze off the GPU, or on it.
 *
 * BREEZE SHARES THE GPU with ComfyUI — ~8.5GB resident, measured beside a
 * render on the pod where it killed a 311-frame block outright. Every line an
 * episode speaks is synthesised at PLAN time, so the service has nothing to do
 * during the render leg: the pod parks it there (`worker.py`) and this is the
 * desktop's own copy of that rule.
 *
 * LAZY IN ONE DIRECTION. Nothing restarts it after a render — the next job
 * that needs a voice ensures it, which is what stops a render leg paying the
 * 8.5GB load twice.
 *
 * Pure, so every case is a test rather than a machine.
 */
export function speechNeedOf(job: {
  kind: string; payload?: Record<string, unknown> | null;
}): "park" | "ensure" | null {
  const p = (job.payload ?? {}) as {
    provider?: string; dialogue_provider?: string; task?: string;
  };
  // A ComfyUI render wants the whole card.
  if (RENDER_KINDS.has(job.kind)) return "park";
  // A line, or a clone made from one: both go through `handle_tts` /
  // `voice_clone`, and both refuse without a live service. ANY local engine —
  // named rather than assumed, because a `tts` job carrying `provider: "qwen"`
  // returned null here and the service was never brought up, so `handle_tts`
  // resolved nothing and fell through to the OpenAI chain: a stock voice where
  // a cast one was asked for, logged and otherwise silent.
  if ((job.kind === "tts" || job.kind === "voice_clone")
      && isLocalSpeech(p.provider)) {
    return "ensure";
  }
  // A PLAN measures every line it writes, which is where an episode's voices
  // are cast and its shot durations floored. Unset counts: `provider_default`
  // picks Breeze whenever `BREEZE_TTS_URL` is set, which `plan_run` only does
  // when the service is answering — so "unset" here means "whatever the child
  // decides", and ensuring is the cautious direction.
  if (job.kind === "llm_task" && p.dialogue_provider !== "elevenlabs") return "ensure";
  return null;
}

const isLocalSpeech = (v: string | undefined): boolean =>
  !!v && (LOCAL_ENGINES as readonly string[]).includes(v);

/**
 * WHICH engine a job wants brought up, or null for "whichever is here".
 *
 * Separate from `speechNeedOf` because they answer different questions and
 * only one of them has an answer for a PARK: parking is all-of-them (the pod's
 * `voice_engines.park_all`, and its reason — "a box serving two engines that
 * only parked one would meet the OOM through the engine nobody was watching"),
 * while ensuring is one.
 *
 * Null is a real answer rather than a failure: a plan that named no provider
 * lets the child decide, and `plan_run` only tells it about engines that are
 * already answering — so the caller brings up whatever is installed and
 * `resolve_provider` picks from what it finds.
 */
export function speechEngineOf(job: {
  kind: string; payload?: Record<string, unknown> | null;
}): string | null {
  const p = (job.payload ?? {}) as { provider?: string; dialogue_provider?: string };
  const named = job.kind === "llm_task" ? p.dialogue_provider : p.provider;
  return isLocalSpeech(named) ? named! : null;
}

/**
 * Of those, the ones a LOCAL project may queue at all.
 *
 * ALL OF THEM, now that there is a desktop model map. `launch_render` used to
 * be the exception: it runs here perfectly well — it is arithmetic over the
 * storyboard — but what it EMITS is one `master_pass` per block, and a master
 * pass resolved its graph through the POD's model map, so every one of those
 * would have failed the moment it was claimed. With
 * `infra/model_map.desktop.json` it resolves against files the engine window
 * downloaded instead, and `sb.insert` routes the emitted jobs to this
 * machine's own lane.
 *
 * Kept as its own name rather than folded into `PY_KINDS`: the two answer
 * different questions ("can this build run it" and "may a local project queue
 * it"), and the day a kind is runnable-but-not-for-a-local-project again,
 * the caller that needs to know is already asking the right one.
 *
 * THAT DAY IS `image_gen`, and it is the one exception. Whether an image job
 * can run here is a question about the MODEL, not the kind: a desktop-map row
 * with its weights on disk renders through the bundled Python, a `local:` id
 * through the TypeScript runner, a studio-hosted row through the `hosted`
 * edge function —
 * and a pod-only row (Krea 2 among them, whose abliterated encoder the engine
 * window cannot fetch) through none of them. Listing the kind here would turn
 * that last case from a refusal at the queue, naming the fix, into a job that
 * is claimed and dies inside `resolve.py`. `enqueueJob` makes the per-model
 * decision instead, and sets the lane before this set is consulted.
 */
export const LOCAL_PROJECT_KINDS: ReadonlySet<string> =
  new Set([...PY_KINDS].filter((k) => k !== "image_gen"));

/**
 * Where a plan for `backend` should run, and why.
 *
 * Returns the providers whose keys it may spend — empty for the local model,
 * which spends nothing. `null` means "the pod": either this machine cannot
 * plan, or the backend chosen is one only the studio holds a credential for.
 *
 * SYMMETRIC WITH `routeHere`, and deliberately so: a picked backend is
 * honoured, `auto` prefers this machine when it can answer for free, and
 * neither reaches for a stored key that was not chosen.
 */
export async function planHere(backend: string | undefined): Promise<
  { providers: string[]; why: string } | null> {
  if (!isDesktop()) return null;
  if (!(await plannerInstalled())) return null;

  const p = byokBackendProvider(backend);
  if (p) {
    await refreshByok();
    // A chosen BYOK backend with no key is an ERROR at the caller, not a
    // quiet fall-through to the pod — the same rule `desktopTurn` follows.
    if (!hasKey(p)) return null;
    return { providers: [p], why: `your ${p} key, on this machine` };
  }
  // `ollama-local` and `auto` both mean "here if this machine can answer".
  if (backend && backend !== "auto" && backend !== "ollama-local") return null;
  // Lazily: `localDirector` reaches `lib/supabase`, whose extensionless `.js`
  // specifier `node --test` cannot resolve — and the routing decisions above
  // are exactly what a test needs to reach.
  const { localDirectorModel } = await import("./localDirector.ts");
  return (await localDirectorModel())
    ? { providers: [], why: "the local model on this machine" }
    : null;
}

/**
 * Which of the jobs a plan emits this machine can actually serve.
 *
 * HONEST PER KIND, because the answer differs per kind and pretending
 * otherwise queues work nothing will claim.
 *
 *   image_gen      the local worker's own TypeScript renderer, when the
 *                  wizard picked a model this machine has.
 *   tts            the studio's own `handlers/tts`, with the user's own
 *                  speech key. Absent, the pod's key is the only one there is.
 *   launch_render  pure arithmetic over the storyboard plus `planner.py` —
 *                  no ComfyUI, no model map, so it runs here whenever the
 *                  Python does.
 *   master_pass    the block renders, against `model_map.desktop.json`, once
 *                  the weights are downloaded (`renderableHere` is what asks).
 *   audio_slice
 *   music_gen      both come with the render: the desktop map carries Music 3
 *                  and ACE-Step, and an episode whose score waited on the
 *                  studio's cloud while its blocks rendered here would be an
 *                  episode that cannot finish offline.
 *
 * A LOCAL PROJECT HAS NO CHOICE about any of them — the studio's cloud cannot
 * see its rows — so `forceLocal` routes everything regardless of what is
 * installed, and a `tts` with no speech key falls back to a stock voice here
 * rather than to nothing at all. What that machine cannot then do is refused
 * up front by `LOCAL_PROJECT_KINDS`, not discovered per job.
 */
export function planLanes(opts: {
  localImages: boolean;
  /** a speech provider key is on this machine */
  speech?: boolean;
  /** this machine can render a BLOCK — engine, weights and model map */
  render?: boolean;
  /** the project lives here, so the pod is not an option for anything */
  forceLocal?: boolean;
}): Record<string, string> {
  const lanes: Record<string, string> = {};
  if (opts.localImages || opts.forceLocal) lanes.image_gen = "local";
  if (opts.speech || opts.forceLocal) lanes.tts = "local";
  if (opts.render || opts.forceLocal) {
    lanes.launch_render = "local";
    lanes.master_pass = "local";
    lanes.audio_slice = "local";
    lanes.music_gen = "local";
  }
  return lanes;
}

/**
 * Can this machine draw the plan's own reference sheets on `imageModelId`?
 *
 * TWO RUNNERS, and they are not interchangeable — which is the whole reason
 * this is a function rather than `isLocalId`:
 *
 *   `local:` id      `localGraphs` in TypeScript, claimed by `localWorker`.
 *                    It renders a PROMPT. That is right for the composer's
 *                    one-off still and wrong for a sheet, so it is deliberately
 *                    not offered as a plan's image model — see the wizard.
 *   a model_map key  the bundled Python, i.e. `handlers/images.py` itself:
 *                    the real composer, the real late-bound `anchors`, the
 *                    real role attach. This is what makes a plan's sheets
 *                    correct here rather than merely present.
 *
 * The first is kept because a plan whose image model is already a `local:` id
 * behaved this way before `image_gen` reached `plan_cli.KINDS`, and taking it
 * away would move those renders onto a pod that may not be running.
 */
export async function imagesHere(
  imageModelId: string | null | undefined,
): Promise<boolean> {
  const [{ isLocalId }, { modelKeyOf }] = await Promise.all([
    import("./localModels.ts"),
    import("../../director/model_keys.js") as Promise<
      { modelKeyOf: (id?: string | null) => string | undefined }>,
  ]);
  if (isLocalId(imageModelId ?? "")) return true;
  const key = modelKeyOf(imageModelId ?? "");
  return !!key && !!(await renderableHere(key, "image")).model;
}

/**
 * The MODEL a coverage/turnaround sheet renders on.
 *
 * A sheet is a video take, so this is a `models` key and not an `image_models`
 * one — `handlers/orbit._h3_files` reads the video entry's `r2v` mode, which
 * is what a coverage take conditions its reference set on. PDD is the default
 * because it is the distillation that survives our pruned int8 checkpoints
 * whole, and it DEGRADES rather than failing when its node pack is absent
 * (the same render at 25 steps instead of 8, said in the log).
 */
export const SHEET_MODEL_KEY = "minimax-h3-pdd";

/**
 * Can this machine draw a reference sheet as one take right now?
 *
 * `imagesHere`'s twin, and separate from it because they ask about different
 * halves of the model map: the wizard's image pick draws the ANCHOR plate and
 * this draws every view around it. The two genuinely disagree — a laptop can
 * hold Krea 2 and not the 32GB H3 reference checkpoint — and answering the
 * image question for both would queue a sheet onto a lane that then refuses
 * to resolve it.
 *
 * A `false` is not a failure: the caller routes to the pod, which is where
 * these have always been drawn.
 */
export async function sheetsHere(): Promise<boolean> {
  if (!isDesktop()) return false;
  return !!(await renderableHere(SHEET_MODEL_KEY, "video")).model;
}

/**
 * `planLanes`, answered from the machine — the one both wizard call sites use.
 *
 * Separate from `planLanes` (which is pure and tested) because every input is
 * a lookup: is the picked image model one this machine holds, is there a
 * speech key in the keychain, can this machine render a BLOCK on the picked
 * video model, and does this project live here. Doing them at the call site
 * meant the step-4 CARD and the actual QUEUE could answer differently — the
 * card is drawn when the step opens and the queue runs on the click, and a
 * promise made in between is not one.
 */
export async function planLanesHere(
  imageModelId: string | null | undefined,
  projectId: string,
  videoModelKey?: string | null,
  /**
   * WHERE THE USER SAID, when they were given the choice.
   *
   * The wizard's model picker offers a model on each plane that could serve
   * it, so "render this in the studio" is now a thing somebody can pick on a
   * machine that could also render it here — and a lane derived from
   * `renderableHere` alone would quietly overrule them. Absent, the answer is
   * what it always was: here if this machine can.
   *
   * `forceLocal` still wins for a project living on this disk, because that is
   * not a preference — the pod cannot see its rows.
   */
  place?: { render?: "local" | "cloud"; speech?: "local" | "cloud" },
): Promise<Record<string, string>> {
  const [{ isLocalId }, { isLocalProject }] = await Promise.all([
    import("./localModels.ts"),
    // Lazily: `localPlane` reaches `useLiveQuery` and through it `lib/supabase`,
    // whose extensionless specifier `node --test` cannot resolve.
    import("./localPlane.ts"),
  ]);
  await refreshByok();
  const render = place?.render
    ? place.render === "local"
    : !!(videoModelKey ? (await renderableHere(videoModelKey)).model : null);
  const speech = place?.speech
    ? place.speech !== "cloud"
    // A KEY OF YOUR OWN, or an ENGINE of your own. The second is the whole
    // standalone product: with a local engine installed, a plan measures and
    // records every line here with no account at all. ANY of them — asking
    // only the first sent a machine running only the OTHER one to the studio's
    // queue, so its `tts` jobs waited for a pod nobody had started while an
    // engine that could speak sat idle on the same box.
    : SPEECH_PROVIDERS.some((p) => hasKey(p)) || await anySpeechReachable();
  return planLanes({
    localImages: await imagesHere(imageModelId),
    speech,
    render,
    forceLocal: isLocalProject(projectId),
  });
}

/** Is ANY local speech engine answering? `Promise.any` rather than a loop, so
 *  one that is down costs nothing while another is already up — and a rejected
 *  probe is a "no" rather than a throw. */
const anySpeechReachable = async (): Promise<boolean> => {
  const asked = await Promise.all([
    breezeReachable().catch(() => false),
    qwenReachable().catch(() => false),
  ]);
  return asked.some(Boolean);
};

/** Providers whose key lets `handlers/tts` speak here. Read off the registry
 *  rather than listed twice — `unlocks: ["speak"]` is the declaration. */
const SPEECH_PROVIDERS = BYOK_PROVIDERS
  .filter((p) => p.unlocks.includes("speak")).map((p) => p.id);

/**
 * Speech providers with a key on this machine.
 *
 * A PLAN SPENDS ONE, which is why this exists separately from the backend
 * choice. `dialogue_synth` synthesizes every line at plan time to floor its
 * shot's duration — the measurement that replaced the words-per-second guess
 * behind DIALOGUE_CUTOFF — so a plan run here with no speech key silently
 * keeps the guess. That is a WORSE STORYBOARD, not a missing preview, and it
 * is why the wizard unions these into the plan's spendable set and says so on
 * the card rather than leaving it to the backend picker.
 */
export async function speechProvidersHere(): Promise<string[]> {
  await refreshByok();
  return SPEECH_PROVIDERS.filter((p) => hasKey(p));
}

/** The kinds a desktop plan still needs the pod for, given those lanes. */
export function podStillNeeded(lanes: Record<string, string>): string[] {
  const LABEL: Record<string, string> = {
    image_gen: "reference sheets and panels",
    tts: "voice references",
    music_gen: "the score",
    launch_render: "planning the episode's blocks",
    master_pass: "rendering the blocks",
  };
  return Object.keys(LABEL).filter((k) => lanes[k] !== "local").map((k) => LABEL[k]);
}

/* ── can this machine render a block at all ─────────────────────────────── */

export interface DesktopRenderModel {
  /** the model_map key, e.g. `minimax-h3` */
  key: string;
  /** which section of the map it came from. THE TWO ARE SEPARATE ID SPACES —
   *  `minimax-h3` is a video entry and `h3-image` an image one — so a caller
   *  that asks without saying which can match the wrong table. */
  kind: "video" | "image";
  modes: string[];
  /** every weight file it names is on disk right now */
  ready: boolean;
  /** the ones that are not, so the engine window can be pointed at them */
  missing: string[];
  /** The precision rung this machine would render on, when it is NOT the one
   *  the map declares — `planner.rs::apply_rungs` lets a laptop holding Klein
   *  4B at Q4_K_M satisfy an entry naming the fp8. Absent means the declared
   *  one. It is SHOWN rather than kept internal: a row reading "on this
   *  machine" while loading weights the map does not name is the silent
   *  substitution this codebase treats as a bug everywhere else. */
  rung?: string | null;
}

/**
 * The model_map keys this build could render a BLOCK with.
 *
 * TWO FACTS, NOT ONE, and both matter before an episode is queued: a key this
 * build does not carry can never render here (the map is generated and pruned
 * — H3 is in it, its turbo twin is not, because the distillation needs a node
 * pack the installer does not add), and one whose 57GB of weights are not
 * downloaded yet is a job that would fail on its first resolve. Saying so up
 * front is the difference between "download H3 first" and twenty blocks that
 * each die a minute apart.
 */
export async function desktopRenderModels(): Promise<DesktopRenderModel[]> {
  if (!isDesktop()) return [];
  return (await invoke<DesktopRenderModel[]>("desktop_render_models")) ?? [];
}

/** Can this machine render a block on `modelKey` right now? Null when it
 *  cannot, with the reason; the model itself when it can. */
export async function renderableHere(
  modelKey: string | null | undefined,
  kind: "video" | "image" = "video",
): Promise<{ model: DesktopRenderModel | null; why: string }> {
  if (!modelKey) return { model: null, why: "no model was picked" };
  if (!(await plannerInstalled())) {
    return { model: null, why: "the local engine's Python is not installed" };
  }
  // FFMPEG IS A PRECONDITION OF A BLOCK RENDER, not only of a timeline one:
  // `plan_cli.KINDS` marks `master_pass` as "render", which wants ffmpeg AND
  // ffprobe as well as the model map — the trim that takes the warmup off
  // every take runs through it. Asked here for the same reason the weights
  // are: an episode queued without it is twenty blocks that each die a minute
  // apart, and the fix is one button in a window nobody was sent to.
  if (!(await engineStatus())?.ffmpeg) {
    return {
      model: null,
      why: "ffmpeg is not installed \u2014 the engine window has it under "
        + "\u201cUtilities only\u201d",
    };
  }
  // A build older than the `kind` field reports none, so an absent one is
  // read as the section it was: this command carried video rows alone.
  const all = await desktopRenderModels();
  const rows = all.filter((r) => (r.kind ?? "video") === kind);
  const m = rows.find((r) => r.key === modelKey);
  if (!m) {
    return {
      model: null,
      // THREE DIFFERENT SENTENCES, because they have three different fixes.
      // An empty list ENTIRELY is the bundling failure the desktop map has
      // already had once (the resource landed as a file literally named
      // `infra`, and every render kind was quietly refused); an empty list for
      // this KIND is the generator having pruned the section; and a list that
      // simply does not name this key is a pick to change.
      why: !all.length
        ? "this build carries no desktop model map"
        : rows.length
        ? `this build cannot render ${modelKey} on your own machine — it can render `
          + rows.map((r) => r.key).join(", ")
        : `this build's model map carries no ${kind} models`,
    };
  }
  if (!m.ready) {
    // Nothing to name means the weight scan could see none of its files — a
    // model whose weights live outside ComfyUI's tree. "Not downloaded" would
    // send someone to a download that does not exist.
    if (!m.missing.length) {
      return {
        model: null,
        why: `this build cannot tell which files ${modelKey} needs — its weights `
          + "are not in ComfyUI's model tree, so it runs on the studio's pod",
      };
    }
    return {
      model: null,
      why: `${modelKey} is not downloaded yet — the engine window is missing `
        + `${m.missing.length} file(s), starting with ${m.missing[0]}`,
    };
  }
  return { model: m, why: `${modelKey}, on this machine` };
}

/**
 * Run one job here, start to finish.
 *
 * The job row must already exist — the Python writes its own progress and
 * reads its own `cancel_requested` from it, exactly as it does on the pod, so
 * every queue surface works with no second implementation.
 *
 * `localProject` names the project when it lives on this machine. Its rows are
 * then served over loopback by `localDbBridge` and its media folder is derived
 * on the Rust side, so the SAME handlers write where the browser can already
 * read.
 */
export async function runJobHere(
  job: Job, providers: string[], localProject: string,
): Promise<PlanOutcome> {
  return await invokeStrict<PlanOutcome>("plan_run", {
    job: JSON.stringify(job),
    providers,
    // The planner's local backend talks to the same Ollama the director does.
    ollamaUrl: "http://127.0.0.1:11434",
    // THE PROJECT IS ALWAYS NAMED. Its rows are served to the child over
    // loopback by `dbproxy` and its media folder is derived on the Rust side,
    // so the SAME handlers the pipeline has always used write where the
    // browser can already read — with no bucket, no session and no network.
    localProject,
  });
}

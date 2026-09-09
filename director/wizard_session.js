// A one-shot session, as something that survives the modal closing.
//
// The transcript and the brief were already durable (chat_messages,
// chat_threads.brief) but everything around them — which step you reached, the
// plan job you were waiting on, the length and experts and models picked along
// the way — lived in React state and died with the modal. Since the wizard
// thread *is* the session, that state rides on `chat_threads.wizard`, and these
// helpers are the contract between what the modal holds and what the row keeps.
//
// Plain JS for the same reason personas.js and brief.js are: imported by the
// frontend and testable with `node --test` without a build step.
import { EXPERT_IDS, briefIsEmpty, briefReadiness } from "./brief.js";

// 480p renders at H3's native 864x480 — an actual entry in H3_NATIVE_DIMS
// (worker/graphs.py), not a downscale, so it costs no quality snap. See
// RES_DIMS in WizardModal.tsx for the full id -> {w,h} mapping.
export const RESOLUTIONS = ["480p", "704p", "720p", "1080p"];

/** What a plan may draw on its own — `src/lib/planAuto.ts`'s `AutoKey`.
 *
 *  DUPLICATED HERE because this module is plain JS shared by the wizard and
 *  the serverless functions, and `planAuto.ts` is TypeScript the functions do
 *  not bundle. Whitelisted rather than passed through: the value comes off a
 *  `chat_threads` row, so an unknown id would ride into `planAutoFlags` and
 *  quietly widen what a plan spends. Pinned against the TS side by
 *  `wizard_session.test.mjs`.
 */
export const AUTO_IDS = ["sheets", "panels", "voices"];
/** What you can make. Mirrors the MEDIUM blocks in personas.js. */
export const MEDIA = [
  { id: "film", label: "Film" },
  { id: "series", label: "Series" },
  { id: "music_video", label: "Music video" },
];
export const MEDIUM_IDS = MEDIA.map((m) => m.id);
const clampStep = (n) => Math.min(4, Math.max(1, Math.round(Number(n) || 1)));

/**
 * Row -> what the modal should restore. Every field is optional: a session
 * saved by an older build (or mid-first-turn) must reopen, not explode, so
 * anything missing or malformed comes back null and the caller keeps its own
 * default rather than being handed a fake one.
 */
export function wizardStateFrom(thread) {
  const w = (thread && thread.wizard) || {};
  const experts = Array.isArray(w.experts)
    ? w.experts.filter((id) => EXPERT_IDS.includes(id)) : null;
  return {
    step: clampStep(w.step),
    planJobId: typeof w.plan_job_id === "string" ? w.plan_job_id : null,
    // A re-plan is a SECOND plan job, and it is tracked apart from the first
    // because `planJobId` gates steps 2-4: pointing it at a running revision
    // would take the whole wizard back to "the storyboard isn't planned yet"
    // and hide the plan the user is deciding about. It rides the session for
    // the same reason the first one does — a re-plan is minutes of pod work,
    // and closing the modal must not orphan it. The board it holds on screen
    // is NOT stored: it is `payload.revise_of` on the job itself, and one
    // source is the only way the two cannot disagree after a reload.
    replanJobId: typeof w.replan_job_id === "string" ? w.replan_job_id : null,
    medium: MEDIUM_IDS.includes(w.medium) ? w.medium : null,
    tier: w.tier === 1 ? 1 : w.tier === 2 ? 2 : null,
    lengthS: Number(w.length_s) > 0 ? Math.round(Number(w.length_s)) : null,
    experts: experts && experts.length ? experts : null,
    backend: typeof w.backend === "string" && w.backend ? w.backend : null,
    res: RESOLUTIONS.includes(w.res) ? w.res : null,
    // WHAT THE PLAN DRAWS FOR YOU (src/lib/planAuto.ts). Saved for the reason
    // `review` and `refine` are, with the same edge: it is spent by the plan
    // and then invisible, so a draft reopened with it silently back on queues
    // a sheet, a panel and a voice for everything in the episode the moment
    // you press Draft — which is precisely the run this switch exists to stop.
    // An ABSENT value is null, not an empty list: a session saved before this
    // existed must fall through to the caller's default rather than reading as
    // a deliberate "draw nothing".
    auto: Array.isArray(w.auto)
      ? w.auto.filter((k) => AUTO_IDS.includes(k)) : null,
    post: Array.isArray(w.post) ? w.post.filter((p) => typeof p === "string") : null,
    // Production QA. Saved like every other step-4 decision, and for a sharper
    // reason than most: it is the one that is invisible once the episode is
    // rendering. A draft reopened with it silently back on would grade an
    // episode the user chose not to have graded, and auto-retake blocks of it.
    review: typeof w.review === "boolean" ? w.review : null,
    // The refinement pass, saved for the same reason and with the same edge:
    // it is invisible once the episode is rendering, and it is the one step-4
    // switch that changes what every block COSTS. A draft reopened with it
    // silently back on spends the extra pass on the whole episode.
    refine: typeof w.refine === "boolean" ? w.refine : null,
    videoModel: typeof w.video_model === "string" && w.video_model ? w.video_model : null,
    // WHERE that model renders. Saved beside it because the step-4 picker
    // offers a model on each plane that could serve it, so "render this in the
    // studio" is a decision somebody makes — and a draft reopened with it
    // silently back on the machine's own default is the substitution the model
    // picker itself refuses to make.
    videoPlane: w.video_plane === "local" || w.video_plane === "cloud"
      ? w.video_plane : null,
    // WHICH ENGINE EVERY CHARACTER IS CAST ON, and where it records.
    //
    // Saved for `videoPlane`'s reason and one sharper: the two local engines
    // differ by LICENCE — Breeze's weights are non-commercial and Qwen3-TTS is
    // Apache 2.0 — so a draft reopened silently back on the default would cast
    // a whole episode on terms the user had deliberately chosen against, and a
    // cast is not re-castable without a re-plan. Any string: the set is
    // `LOCAL_ENGINES` plus elevenlabs, which is decided in the browser and
    // widens when an engine is added.
    dialogueProvider: typeof w.dialogue_provider === "string" && w.dialogue_provider
      ? w.dialogue_provider : null,
    voicePlane: w.voice_plane === "local" || w.voice_plane === "byok"
      || w.voice_plane === "cloud" ? w.voice_plane : null,
    // Saved for the same reason videoModel is: it decides what every sheet,
    // panel and still of this run is drawn by, and a resumed draft that
    // silently reverted to the project default would redraw half a bible on
    // a different family from the half already on disk.
    imageModel: typeof w.image_model === "string" && w.image_model ? w.image_model : null,
    audio: w.audio && typeof w.audio.id === "string"
      ? { id: w.audio.id, name: w.audio.name || "master track" } : null,
    // The "write me a track" spec, if one was set up. Saved for the same
    // reason `audio` is: closing the modal while cast & world generate must
    // not lose a decision, and this one carries typed-out lyrics.
    score: w.score && typeof w.score === "object" ? {
      prompt: String(w.score.prompt ?? ""),
      lyrics: String(w.score.lyrics ?? ""),
      instrumental: !!w.score.instrumental,
      model: typeof w.score.model === "string" && w.score.model
        ? w.score.model : "minimax-music3",
      bpm: Number(w.score.bpm) > 0 ? Math.round(Number(w.score.bpm)) : 100,
    } : null,
    queuedAt: typeof w.queued_at === "string" ? w.queued_at : null,
  };
}

/** The modal's state -> the row. Mirror of wizardStateFrom. */
export function wizardStateTo(s) {
  return {
    step: clampStep(s.step),
    plan_job_id: s.planJobId ?? null,
    replan_job_id: s.replanJobId ?? null,
    medium: MEDIUM_IDS.includes(s.medium) ? s.medium : null,
    tier: s.tier === 1 ? 1 : 2,
    length_s: Number(s.lengthS) || null,
    experts: Array.isArray(s.experts) ? s.experts : [],
    backend: s.backend ?? null,
    res: RESOLUTIONS.includes(s.res) ? s.res : null,
    auto: Array.isArray(s.auto) ? s.auto.filter((k) => AUTO_IDS.includes(k)) : [],
    post: Array.isArray(s.post) ? s.post : [],
    review: s.review !== false,
    refine: !!s.refine,
    video_model: s.videoModel ?? null,
    video_plane: s.videoPlane === "local" || s.videoPlane === "cloud"
      ? s.videoPlane : null,
    dialogue_provider: s.dialogueProvider ?? null,
    voice_plane: s.voicePlane === "local" || s.voicePlane === "byok"
      || s.voicePlane === "cloud" ? s.voicePlane : null,
    image_model: s.imageModel ?? null,
    audio: s.audio?.id ? { id: s.audio.id, name: s.audio.name ?? "" } : null,
    score: s.score ? {
      prompt: s.score.prompt ?? "", lyrics: s.score.lyrics ?? "",
      instrumental: !!s.score.instrumental,
      model: s.score.model ?? "minimax-music3",
      bpm: Number(s.score.bpm) || 100,
    } : null,
    ...(s.queuedAt ? { queued_at: s.queuedAt } : {}),
  };
}

/** Where a saved session got to, for the history list. */
export function sessionStatus(thread) {
  const w = (thread && thread.wizard) || {};
  const r = briefReadiness(thread?.brief);
  if (w.queued_at) return { key: "queued", label: "queued", tone: "#6fd08c" };
  if (clampStep(w.step) >= 3) return { key: "storyboard", label: "storyboard", tone: "#5aa2ff" };
  if (clampStep(w.step) === 2) return { key: "cast", label: "cast & world", tone: "#c97aff" };
  if (w.plan_job_id) return { key: "drafting", label: "drafting", tone: "#e8c268" };
  if (r.enough) return { key: "ready", label: "ready to draft", tone: "#6fd08c" };
  return { key: "brief", label: "brief", tone: "#5e6678" };
}

/** A name for a session that never got one: the story, in a few words. */
export function sessionTitle(thread) {
  const b = thread?.brief ?? {};
  const first = [b.title, b.logline, b.premise, thread?.preview, thread?.title]
    .map((s) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ") : ""))
    .find(Boolean);
  if (!first) return "Untitled brief";
  return first.length > 58 ? `${first.slice(0, 57)}…` : first;
}

/**
 * Which session to reopen when the wizard is opened cold. Newest-first input.
 *
 * A queued session is finished — reopening it would put you on step 4 of an
 * episode already rendering — and an empty one has nothing to restore, so both
 * are skipped in favour of starting fresh.
 */
export function pickResumeSession(threads) {
  for (const t of threads ?? []) {
    if (t?.wizard?.queued_at) continue;
    const started = !briefIsEmpty(t?.brief) || (t?.turns ?? 0) > 0;
    if (started) return t;
  }
  return null;
}

/**
 * What the director needs to know to be useful *on the cast & world step*.
 *
 * The side chat runs on the wizard's own thread, so the interview is already in
 * its history — what it cannot see is what the planner then wrote into the
 * bible, which is the entire subject of this step. Without this it proposes
 * characters that already exist and asks for a logline it agreed three turns
 * ago. Rides `persona.extra`, so it reaches every backend.
 *
 * @param {{brief?: Record<string, any>, cast?: {name: string, identity_line?: string|null,
 *          status?: string, refs?: number}[],
 *          world?: {name: string, identity_line?: string|null, status?: string, refs?: number}[],
 *          props?: {name: string, identity_line?: string|null, status?: string, refs?: number}[],
 *          medium?: string|null, lengthS?: number}} state
 */
export function castWorldContext(state = {}) {
  const line = (e) => {
    const refs = Number(e.refs) || 0;
    const sheet = refs ? `${refs} ref${refs > 1 ? "s" : ""}` : "no refs yet";
    const id = (e.identity_line || "").trim();
    return `- ${e.name} (${e.status === "confirmed" ? "confirmed" : "draft"}, ${sheet})${
      id ? `: ${id}` : ""}`;
  };
  const cast = (state.cast ?? []).map(line).join("\n") || "- (none yet)";
  const world = (state.world ?? []).map(line).join("\n") || "- (none yet)";
  // Props are on this screen too, so leaving them out of the context makes the
  // director blind to a third of what the user is looking at — and blindness
  // here shows up as duplicates, the same failure the brief digest fixed: a
  // model that cannot see an entry writes it down again under a new name.
  const props = (state.props ?? []).map(line).join("\n") || "- (none yet)";
  const b = state.brief ?? {};
  const shape = [b.logline || b.premise, b.turn && `Turn: ${b.turn}`,
                 b.tone && `Tone: ${b.tone}`, b.palette && `Palette: ${b.palette}`]
    .filter(Boolean).join(" · ");

  return `# Where we are: the wizard's cast & world review

The storyboard has been planned${state.medium ? ` for a ${String(state.medium).replace("_", " ")}` : ""}${
  state.lengthS ? ` of about ${state.lengthS}s` : ""} and the user is reviewing who
is in it, where it happens and what they handle, before any of it renders.

Brief: ${shape || "(thin — ask before inventing)"}

Cast currently in the bible:
${cast}

Locations currently in the bible:
${world}

Props currently in the bible:
${props}

What to do here:
- Add or change entries with update_bible_entry. New ones are drafts; existing
  ones become proposed revisions the user confirms. Never invent a second
  version of someone already listed above — refine that entry instead.
- An identity line is 6-8 concrete visual attributes, repeatable verbatim in
  every shot: hair, eyes, build, marks, named garments with colours. Not mood.
- generate_image queues a reference sheet (bible_entry_id + role). Say what it
  costs before queueing more than a couple.
- Answer in at most two sentences. The user is looking at the cards, not at
  your prose — do the thing and say what you did.`;
}

/**
 * The storyboard as the director needs to see it to change it: ids included,
 * because `update_scene` takes a scene_id and guessing one is not a thing a
 * model should be asked to do. Same delivery as castWorldContext — persona
 * extra, so every backend gets it.
 *
 * @param {{scenes?: {id: string, idx: number, slug?: string|null, duration_ms?: number,
 *          scene_prompt?: string|null, cast?: string[], environment?: string|null,
 *          beats?: {id: string, idx: number, action?: string, camera?: string|null,
 *                   duration_ms?: number, dialogue?: {speaker?: string, line?: string}[]}[]}[],
 *          blocks?: number, totalS?: number, medium?: string|null}} sb
 */
export function storyboardContext(sb = {}) {
  const scenes = (sb.scenes ?? []).map((s) => {
    const head = `S${s.idx + 1} ${s.slug || "(unnamed)"} — ${
      ((s.duration_ms ?? 0) / 1000).toFixed(1)}s · scene_id ${s.id}`;
    const where = [s.environment && `at ${s.environment}`,
                   s.cast?.length && `with ${s.cast.join(", ")}`].filter(Boolean).join(", ");
    const beats = (s.beats ?? []).map((b) => {
      const said = (b.dialogue ?? []).map((d) => `${d.speaker ?? "?"}: "${d.line ?? ""}"`).join(" ");
      return `    b${b.idx + 1} (${((b.duration_ms ?? 0) / 1000).toFixed(1)}s, beat_id ${b.id}): ${
        (b.action || "").trim()}${b.camera ? ` [${b.camera}]` : ""}${said ? ` ${said}` : ""}`;
    }).join("\n");
    return [`- ${head}`, where && `    ${where}`, s.scene_prompt && `    ${s.scene_prompt}`, beats]
      .filter(Boolean).join("\n");
  }).join("\n") || "- (no scenes yet)";

  return `# Where we are: the wizard's storyboard review

The plan exists and nothing has rendered. The user is reading the scenes and can
change any of them — through you or by opening the scene editor.

${sb.blocks ? `${sb.blocks} generation blocks` : "Blocks"}${
  sb.totalS ? `, ${sb.totalS.toFixed(1)}s total` : ""}. Each block is one H3 pass of at
most 15s, chained on its final frame.

Scenes:
${scenes}

What to do here:
- **You change this storyboard yourself, in this conversation.** add_scene,
  update_scene, delete_scene, add_beat, update_beat, delete_beat all act on the
  rows above, using the ids above. That includes big changes: a new direction,
  a different act structure, cutting half the scenes and writing new ones.
- **Do not call plan_storyboard.** It is a job queued in the studio cloud — it waits for
  a worker that may be asleep, and it discards this plan and every edit made to
  it. It is only for planning from scratch when nothing exists yet. If the user
  really wants to start over from the brief, say what that costs and ask first.
- Change what was asked and nothing else; do not rewrite a scene the user did
  not mention. When you restructure, do it as a series of edits and then say in
  one line what the shape now is.
- Editing a scene or beat makes the blocks covering it stale — that is fine
  before a render, but say so.
- Beats are what the compiler reads: concrete physical action, camera as type +
  amplitude + speed in prose, dialogue as lines with a speaker. You never write
  the compiled H3 prompt format yourself.
- Durations are milliseconds, and a beat runs 2-12 seconds.
- Answer in at most two sentences: make the change and say what you changed.`;
}

/**
 * Which reference sheets go into a scene's key still, and in what order.
 *
 * The point of the still is that it shows the *cast the blocks will render*, so
 * identity refs come first and the location rides last. Four is the ceiling —
 * `Krea2EditRebalance` takes no more (CLAUDE.md), and a fifth would be dropped
 * silently by the node rather than by us.
 *
 * @param {{castIds?: string[], environmentId?: string|null,
 *          firstRefOf: (entryId: string) => string|undefined, max?: number}} o
 * @returns {string[]} asset ids
 */
export function pickStillRefs({ castIds = [], environmentId, firstRefOf, max = 4 }) {
  const env = environmentId ? firstRefOf(environmentId) : undefined;
  const cast = castIds.map(firstRefOf).filter(Boolean);
  const room = env ? max - 1 : max;
  return [...new Set([...cast.slice(0, room), ...(env ? [env] : [])])];
}

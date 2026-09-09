// Director chat client.
//
// ONE TRANSPORT: the turn is answered on this machine, by whichever model can
// answer it — a provider key of your own, held in the OS keychain and spent by
// the app's own native layer, or an Ollama on loopback. Both run the SAME
// forty-tool loop over the SAME rows, and both write the reply into
// `chat_messages`, which is what makes the transcript render identically
// however it was answered.
//
// The cloud build had a second transport — SSE from a server-side endpoint
// holding the studio's own provider credentials — and that is the whole of
// what was removed. What is left is the path that never needed a credential
// belonging to somebody else.
import { supabase } from "./supabase";
import { isDesktop } from "./desktop";
import { installedDirectorModel, ollamaChat, ollamaStatus } from "./ollamaLocal";
import type { ChatFn } from "./localDirector";
import type { ModelTier } from "./localModels";
import { byokBackendId, byokBackendProvider, byokModelFor, chatFor,
         CHAT_MODELS, type ChatProvider } from "./byokChat";
import { hasKey, refreshByok } from "./byok";
import { localDirectorModel, runLocalDirectorTurn } from "./localDirector";
import { buildPersona, CHAT_TOOLS_NOTE } from "../../director/personas.js";
import { interviewSystem } from "../../director/brief.js";
import type { BriefToolCtx } from "./localBrief";
import { BRIEF_TOOLS, BRIEF_TOOL_NAMES, runBriefTool } from "./localBrief";
import { hasChanges } from "../../director/changes.js";
import { editSystem, enhanceSystem, guideFor, h3AlignmentLine } from "../../director/prompt_guides.js";

export type DirectorEvent =
  | { t: "thread"; id: string }
  | { t: "delta"; text: string }
  /** `block_id` rides on an ok result that made or re-rendered a block, so
   *  the dock can put a placeholder on the open cut the moment it happens —
   *  the same pre-insert the timeline's own extend/chain do. */
  | { t: "tool"; name: string; status: "run" | "ok" | "err"; detail?: string;
      block_id?: string; job_id?: string }
  | { t: "brief"; brief: Record<string, unknown> }
  | { t: "fallback"; from: string; to: string; reason: string; note?: string }
  | { t: "job"; id: string }
  | { t: "done"; message_id?: string; cost_usd?: number; tokens_out?: number; backend?: string }
  | { t: "error"; message: string };

/** One thing the user put in the composer alongside the words: a registered
 *  asset, or a generation block. The server appends pictures to the turn and
 *  persists a matching content block onto the message (see `attachmentBlock`),
 *  which is what makes an attachment survive a reload instead of being a
 *  one-shot upload nobody can see afterwards. */
export interface ChatAttachment {
  kind: "asset" | "block";
  id: string;
  b2_key?: string;
  media?: "image" | "video" | "audio" | "file";
  label?: string;
  text_content?: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  bytes?: number;
  url?: string;
  /** blocks only, and NOT part of the wire contract — the hosted endpoint
   *  ignores it and resolves the index itself. It rides along because the
   *  local path writes the `block_ref` content block in the browser, and that
   *  block carries `idx`. */
  idx?: number;
}

export interface ChatRequest {
  project_id: string;
  episode_id?: string | null;
  thread_id?: string | null;
  text: string;
  backend?: string;
  persona?: { medium?: string; genre?: string[]; style?: string; extra?: string };
  /** "Where the user is", appended to the system prompt — see
   *  lib/directorContext. Compiled fresh per turn rather than stored on the
   *  thread: it describes the screen at the moment of asking, and a stale one
   *  is worse than none. */
  context?: string;
  attachments?: ChatAttachment[];
  /** The VIDEO picker as it stands at send time (a catalog id). It is written
   *  to `projects.settings` too, but that is a round trip: pick a checkpoint
   *  and send in the same breath and the row the runner reads is still the old
   *  one. Sent so the turn renders on what is on screen. */
  video_model?: string;
  /** A RETRY ANSWERS THE MESSAGE THAT IS ALREADY THERE. Both transports write
   *  the user's row before they stream, so a failed turn has usually already
   *  posted it — sending the same words again would show one turn twice.
   *  Decided by the caller from the transcript (`prepareRetry`), not assumed
   *  from the failure: a 401 never reaches the insert at all, and resuming
   *  there would answer the PREVIOUS turn. */
  resume?: boolean;
}

/** The content block a `chat_messages` row stores for one attachment. Both
 *  transports must agree on this shape — the hosted endpoint writes it
 *  server-side, the local path writes it here — because `Msg` renders it and
 *  the worker rebuilds history from it. */
export function attachmentBlock(a: ChatAttachment): Record<string, unknown> {
  if (a.kind === "block") {
    return { type: "block_ref", block_id: a.id, label: a.label ?? null, idx: a.idx ?? null };
  }
  return {
    type: "asset_ref", asset_id: a.id, b2_key: a.b2_key ?? null,
    media: a.media ?? null, label: a.label ?? null,
    ...(a.width ? { width: a.width } : {}),
    ...(a.height ? { height: a.height } : {}),
    ...(a.duration_ms ? { duration_ms: a.duration_ms } : {}),
  };
}

/** The wizard's interview turn carries the room and the shape with it.
 *  `resume` is ChatRequest's — the wizard's own retry and the dock's are the
 *  same thing said twice. */
export interface BriefRequest extends ChatRequest {
  experts?: string[];
  length_s?: number;
}

/** Short label for a backend id, for "fell back to …" notices. */
export const backendLabel = (id: string) =>
  DIRECTOR_BACKENDS.find((b) => b.id === id)?.label ?? id;

/** Just the model's name, for the thread list — which records what a thread
 *  RAN ON. Falls back to the raw id rather than to "Auto": a thread opened on
 *  a model since retired must stay legible as itself, and once a BYOK id
 *  carries its model (`byok:google:gemini-3.8-flash`) the raw string is too
 *  long to sit in that row. */
export const backendModelName = (id: string) =>
  DIRECTOR_BACKENDS.find((b) => b.id === id)?.model ?? id;

/** Provider failures reach the browser as a wall of JSON (`429 {"type":"error",
 *  "error":{...},"request_id":"req_011…"}`) which tells the user nothing they
 *  can act on. Keep the code, drop the envelope. Hosted turns are humanized
 *  server-side; this catches network and client-side failures too. */
export function describeDirectorError(raw: string): string {
  const text = String(raw ?? "").trim();
  const status = Number((text.match(/\b(4\d\d|5\d\d)\b/) || [])[1]) || null;
  // OUT OF CREDIT IS NOT A RATE LIMIT, and both arrive as 429. One clears in a
  // moment and the other never does, so the twin of `explainError`'s rule
  // lives here too: telling somebody to try again is telling them to press a
  // button that cannot work. The backend picker at the foot of the dock is
  // the thing that does, so the message names it.
  if (/insufficient_quota|credit_balance_exhausted|no credits remaining|exceeded your current quota|out of credit/i
      .test(text)) {
    return "out of credit on that provider — switch the model below, or add credit";
  }
  if (/rate.?limit/i.test(text) || status === 429) return "rate limited — try again in a moment";
  if (/overload|capacity/i.test(text) || status === 529) return "the model is overloaded";
  if (status === 401 || status === 403) return "credentials rejected";
  if (/failed to fetch|networkerror|load failed/i.test(text)) return "network error — is the dev server up?";
  // Non-JSON messages are ours and already readable; JSON ones get their
  // message field lifted out rather than printed whole.
  try {
    const j = JSON.parse(text.replace(/^\s*\d{3}\s*/, "")) as { error?: { message?: string } };
    const m = j?.error?.message;
    if (m) return status ? `${m} (${status})` : m;
  } catch { /* not JSON */ }
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

export interface DirectorBackend {
  id: string;
  /** which plane it runs on — the same three the model picker groups by.
   *  `auto` has none: it is a router, not a place. */
  tier?: ModelTier;
  /** full single-line description — header subtitle, fallback notices, plain <select>s */
  label: string;
  /** the exact model this backend runs, for display (server default; see director/_backends.js) */
  model: string;
  /** compact form for the cramped dock trigger */
  short: string;
  /** connection method, shown as the row's badge */
  connection: string;
  /** one-sentence explanation, shown under the model name and as the row's title */
  hint: string;
  /** a caveat worth flagging up front, e.g. "needs a key" */
  flag?: string;
}

/** The vendor's own name for the key, for the row's label. Not the provider
 *  id: "your google key" is what the keys tab calls it, "your Google key" is
 *  what a person calls it. */
const PROVIDER_NAME: Record<ChatProvider, string> = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google",
};

/**
 * The BYOK rows — ONE PER MODEL, the same models the studio's own section
 * offers, plus the Gemini ones only a key of your own can reach.
 *
 * It used to be one row per PROVIDER ("Claude", "GPT", "Gemini"), each running
 * whatever `chatModelFor` had stored, next to six named studio models. So the
 * plane whose whole promise is "your key, your choice" was the one with no
 * choice in it, and Opus-over-Haiku was a decision you could only make on the
 * credential you do not pay for.
 *
 * Built from `CHAT_MODELS` rather than written out, so a model added there
 * cannot arrive with a working adapter and no way to pick it — and so the
 * NAME under both headings is one string, not two that agree today.
 *
 * ONE ROW PER MODEL EVEN WITH NO KEY, which is `byokOfferRows`' rule in the
 * model picker and settled for the same reason: collapsing them to one row per
 * provider leaves the only section that cannot answer a picker's whole
 * question, which is "which models would this key buy me". A keyless row is
 * blocked, says `add your <provider> key`, and is a button onto the screen
 * that fixes it.
 */
const BYOK_BACKENDS: DirectorBackend[] = CHAT_MODELS.map((m) => ({
  id: byokBackendId(m.provider, m.api), tier: "byok" as const,
  label: `${m.model} · your ${PROVIDER_NAME[m.provider]} key`,
  model: m.model, short: m.short,
  connection: "Your key",
  hint: m.hint,
}));

export const DIRECTOR_BACKENDS: DirectorBackend[] = [
  {
    id: "auto", label: "Auto · best configured",
    model: "Auto", short: "Auto", connection: "Best configured",
    // THE OLD COPY DESCRIBED THE HOSTED ROUTE ONLY, and so did the routing:
    // `auto` posted to the studio's endpoint, so a machine with a local model
    // and no studio credential got a failed turn from the option named "best
    // configured". See `routeHere`.
    hint: "This machine first when a local model is installed, then the studio's "
        + "backends. Never spends one of your API keys — pick that key to do that.",
  },
  {
    // One row, two places, and the row cannot say which in advance: on the
    // desktop this runs on THIS MACHINE whenever a local model is installed
    // (`localDirectorModel`), and falls through to the pod otherwise. Naming
    // one of them would be wrong half the time — a picker that promises the
    // pod and answers from loopback is the same silent substitution this
    // codebase keeps naming, just in the friendly direction.
    id: "ollama-local", tier: "local", label: "Ollama · no API key",
    model: "Ollama", short: "Ollama", connection: "Local",
    hint: "Runs on this machine, on a model you host — see the local engine "
        + "screen. Costs nothing per turn and never leaves the machine.",
  },
  ...BYOK_BACKENDS,
];

/**
 * The id a QUEUED PIPELINE JOB (`plan_storyboard` and its re-plan twin)
 * should carry, given what the chat picker has selected.
 *
 * The picker offers several MODELS per provider — Opus/Sonnet/Haiku,
 * Luna/Sol/Terra — because a CHAT turn benefits from choosing one. The
 * pipeline's own backend selection (`worker/llm.py`'s `pick_backend`) has no
 * such concept: every Anthropic pick there runs on the worker's own
 * `ANTHROPIC_MODEL`, and every OpenAI pick on the job's own `llm_model`. An id
 * the worker has never heard of ("claude-api-sonnet") falls straight through
 * `pick_backend`'s explicit-want checks and lands back on its own
 * auto-selected default — silently overriding what the picker chose, which
 * is exactly the wrong-model-answered failure this codebase keeps naming.
 * Collapsing to the base provider id here is what keeps a chat choice and a
 * queued job's choice from disagreeing about which credential they spend.
 */
export function pipelineBackendId(id: string | undefined): string | undefined {
  if (!id || id === "auto") return undefined;
  if (id.startsWith("claude-api")) return "claude-api";
  if (id.startsWith("openai-compat")) return "openai-compat";
  // A BYOK id collapses for the same reason: the model it names is a CHAT
  // choice this browser sends to the vendor itself, and a queued job carries
  // the id only so `byok.key_for` can find the owner's shared key for that
  // PROVIDER. `byok:google:gemini-3.8-flash` says nothing more there than
  // `byok:google` does, and the longer form is one more string the pod would
  // have to be taught to parse.
  const p = byokBackendProvider(id);
  if (p) return byokBackendId(p);
  return id;   // ollama-local, or anything the worker already understands
}

/**
 * Every backend, in tier order — INCLUDING the ones this account cannot use.
 *
 * It used to REMOVE them: a keyless BYOK row was hidden because picking it
 * would fail on a key the picker never mentioned, and a member's cloud rows
 * were hidden because they answer 403. Both were the wrong shape. A picker
 * that hides a whole plane reads as a build with nothing in it, and the two
 * absences are the two things a user most needs to be told: what the studio's
 * cloud IS, and that their own key is one screen away.
 *
 * So nothing is hidden and `backendBlocked` says why a row cannot be picked.
 * The one thing a blocked row must never be is SILENT — see the picker, which
 * turns "add your own key" into a button that opens the keys tab.
 */
export function availableBackends(
  _keyed?: Iterable<string>,
  _opts: { admin?: boolean } = {},
): DirectorBackend[] {
  return DIRECTOR_BACKENDS;
}

/** Why this backend cannot be picked right now, or null. */
export function backendBlocked(
  b: DirectorBackend,
  opts: { admin?: boolean; keyed?: Iterable<string> } = {},
): { why: string; fix?: "keys" } | null {
  const p = byokBackendProvider(b.id);
  if (p) {
    const have = new Set(opts.keyed ?? []);
    return have.has(p) ? null : { why: `add your ${p} key`, fix: "keys" };
  }
  // The studio's own subscription and API keys. `api/director/*` answers 403
  // to anyone but an admin since the standalone release, so this is a fact
  // about the request rather than a policy the picker is inventing.
  if (b.tier === "cloud" && opts.admin === false) {
    return { why: "runs on the studio's own account — coming soon" };
  }
  return null;
}

/** Just the project fields the persona builder reads — nullable to match the
 *  DB row rather than forcing every caller to sanitise. */
export interface DirectorProject {
  title?: string | null;
  medium?: string | null;
  genre?: string[] | null;
  style?: string | null;
  settings?: Record<string, unknown> | null;
}

/**
 * Which model call a desktop-driven turn should make, or null for "none —
 * queue it for the pod instead".
 *
 * TWO WAYS TO GET ONE and they are not the same promise. A `byok:` backend was
 * CHOSEN, so a missing key is an ERROR rather than a quiet fall-through to the
 * pod: answering on a different model than the one in the picker is the silent
 * substitution this codebase keeps naming. `ollama-local` is the opposite —
 * its own row says it runs here when a model is installed and on the pod
 * otherwise — so an absent model there returns null and the caller queues.
 */
export async function desktopTurn(backend: string | undefined): Promise<
  { backendId: string; model: string; chat?: ChatFn } | null> {
  const p = byokBackendProvider(backend);
  if (p) {
    // The keychain is the source of truth and the store may not have been read
    // yet on a fresh load — asking first is cheap, and stops a first turn
    // failing over a key that is actually there.
    await refreshByok();
    if (!hasKey(p)) {
      throw new Error(
        `That backend uses your own ${p} key and this machine has none stored — `
        + `add one in the local engine window, under API keys.`);
    }
    // The id the picker chose already names the model; a bare `byok:<provider>`
    // (an older thread) falls back to the stored default. Either way the
    // RESOLVED id is what is reported, so `chat_threads.backend` records which
    // model answered rather than only which key paid.
    const model = byokModelFor(backend);
    return { backendId: byokBackendId(p, model), model, chat: chatFor(p, model) };
  }
  const model = await localDirectorModel();
  return model ? { backendId: "ollama-desktop", model } : null;
}

/** The browser drives this backend itself rather than posting to `/api/director`.
 *
 *  Two families, for two different reasons: `ollama-local` is queued as a jobs
 *  row because the pod may be the one that runs it (invariant #1), and a
 *  `byok:` backend is run right here because the key is in THIS machine's
 *  keychain and nothing else can reach it. */
export const isLocalBackend = (id: string | undefined) =>
  id === "ollama-local" || !!byokBackendProvider(id);

/** Local turn: queue it and let the store's own change event do the rest. Mirrors what
 *  api/director/chat does for this backend, minus the credential it doesn't
 *  need. Emits the same events as the streaming path so callers don't branch. */
/** The part of a tool result worth persisting on the message: ids, a choice,
 *  the assets a search found, an error — never a whole storyboard. The hosted
 *  handler stores the full result; here it rides through realtime on every
 *  paint, so it is trimmed to what the dock actually draws. */
function compactResult(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["job_id", "block_id", "block", "label", "error", "dry_run", "choice",
                   "renders_on", "placed", "created_entry_id", "proposed_revision_id"]) {
    if (r[k] != null) out[k] = r[k];
  }
  if (Array.isArray(r.assets)) out.assets = r.assets.slice(0, 12);
  return Object.keys(out).length ? out : null;
}

export async function queueLocalDirectorTurn(
  body: ChatRequest & { project?: DirectorProject },
  onEvent: (ev: DirectorEvent) => void,
  /** wizard turns open a 'wizard' thread and append the interview instructions */
  opts: { kind?: "director" | "wizard"; resume?: boolean;
          systemExtra?: (brief: Record<string, unknown>) => string;
          /** extra content blocks to store on the user message beside the text
           *  and the attachments — how a clicked `choice` records its pick as
           *  structure rather than only as a sentence. The hosted endpoint
           *  writes its own row, so this is a local-path affordance. */
          extraBlocks?: Record<string, unknown>[];
          /** WHOSE TOOLS, built once the thread and its brief are known.
           *
           *  Absent means the director's forty. Present means a different
           *  agent with a different contract — today only the wizard's
           *  interview (`localBrief.ts`), whose job is to ask and write the
           *  brief down, not to run the studio. */
          toolset?: (info: {
            projectId: string; threadId: string;
            brief: Record<string, unknown>;
            onBrief: (brief: Record<string, unknown>) => void;
          }) => { tools: { name: string; description: string; input_schema: unknown }[];
                  names: Set<string>;
                  ctx: Record<string, unknown>;
                  run(name: string, input: Record<string, unknown>,
                      ctx: Record<string, unknown>): Promise<unknown> } } = {}
): Promise<void> {
  // The picker on screen wins over the project row for this turn — see
  // `video_model` on ChatRequest.
  const settings: Record<string, unknown> = {
    ...(body.project?.settings ?? {}),
    ...(body.video_model ? { video_model: body.video_model } : {}),
  };
  const personaOpts = {
    // The wizard may be making something other than the project's medium.
    medium: body.persona?.medium ?? body.project?.medium ?? undefined,
    genre: body.persona?.genre ?? body.project?.genre ?? [],
    style: body.persona?.style ?? body.project?.style ?? undefined,
    extra: body.persona?.extra ?? "",
  };

  const threadBackend = byokBackendProvider(body.backend)
    ? body.backend! : "ollama-local";
  let threadId = body.thread_id ?? null;
  let brief: Record<string, unknown> = {};
  if (threadId) {
    const { data } = await supabase.from("chat_threads").select("id,brief").eq("id", threadId).maybeSingle();
    if (data) brief = ((data as { brief?: Record<string, unknown> }).brief ?? {});
    else threadId = null;
  }
  if (!threadId) {
    const { data, error } = await supabase.from("chat_threads").insert({
      project_id: body.project_id, episode_id: body.episode_id ?? null,
      kind: opts.kind ?? "director",
      title: body.text.slice(0, 64), persona: personaOpts,
      // What actually answered, not a constant. A thread reopened later shows
      // its own backend in the dock, and a BYOK thread labelled `ollama-local`
      // would reopen pointed at a model it never used.
      backend: threadBackend,
    }).select("id").single();
    if (error) throw new Error(`could not open a thread: ${error.message}`);
    threadId = (data as { id: string }).id;
  } else {
    await supabase.from("chat_threads").update({ backend: threadBackend }).eq("id", threadId);
  }
  onEvent({ t: "thread", id: threadId });

  // A retry answers the message that is already there — through `opts` from
  // the wizard, or on the request itself from the dock's Retry button.
  const resume = opts.resume ?? body.resume;
  if (!resume) {
    // Attachments go onto the ROW, not just into the request: the worker
    // rebuilds this turn's history from chat_messages, so a picture that lives
    // only in a payload is a picture the model never sees on the next turn —
    // and one the transcript can never show again after a reload.
    const { error: msgErr } = await supabase.from("chat_messages").insert({
      thread_id: threadId, role: "user",
      content: [
        { type: "text", text: body.text },
        ...(body.attachments ?? []).map(attachmentBlock),
        ...(opts.extraBlocks ?? []),
      ],
    });
    if (msgErr) throw new Error(`could not post the message: ${msgErr.message}`);
  }

  // Same order the hosted endpoint composes in: persona, then how to use the
  // tools, then where the user is. `buildPersona` does NOT carry the tools
  // note, so for its whole life this path handed the local backend three
  // dozen tools and not a word about when to reach for which — invisible,
  // because a model with tools and no instructions still answers, it just
  // never edits anything. The wizard's interview is deliberately exempt: it
  // has no editing session to run, and `systemExtra` already carries its own
  // instructions.
  const isDirector = (opts.kind ?? "director") === "director";
  const persona = buildPersona(personaOpts) +
    (isDirector ? `\n\n${CHAT_TOOLS_NOTE}` : "") +
    (opts.systemExtra ? `\n\n${opts.systemExtra(brief)}` : "") +
    // The situational block is the same string on both transports; hosted
    // sends it as `context` and the endpoint appends it there.
    (body.context ? `\n\n${body.context}` : "");
  // ── this machine first ────────────────────────────────────────────────
  // Same toolset, same thread, same rows — the only difference is that the
  // model is on loopback and nothing waits for a pod. Writing into
  // `chat_messages` is what makes the transcript render identically: the dock
  // reads that table over realtime either way, so there is no second UI path.
  // Which model answers this turn: the user's own key, the Ollama on this
  // machine, or neither (queue it). `desktopTurn` THROWS for a chosen-but-
  // keyless BYOK backend rather than falling through, so that case reaches the
  // caller as an error instead of a reply from a model they did not pick.
  const desk = await desktopTurn(body.backend);
  const localModel = desk?.model ?? null;
  if (desk && localModel) {
    const { data: rows } = await supabase.from("chat_messages")
      .select("role,content").eq("thread_id", threadId)
      .order("created_at").limit(40);
    const history = ((rows ?? []) as { role: string; content: unknown[] }[])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role,
        content: (Array.isArray(m.content) ? m.content : [])
          .filter((b): b is { type: string; text?: string } =>
            !!b && typeof b === "object" && (b as { type?: string }).type === "text")
          .map((b) => b.text ?? "").join(" ").trim(),
      }))
      .filter((m) => m.content);
    if (history.length && history[history.length - 1].role === "user") {
      // The row lands FIRST and streaming, exactly as the worker does it, so
      // the transcript shows a turn in progress rather than nothing at all.
      const { data: asst } = await supabase.from("chat_messages").insert({
        thread_id: threadId, role: "assistant",
        content: [{ type: "text", text: "" }], streaming: true,
      }).select("id").single();
      const msgId = (asst as { id: string } | null)?.id ?? null;
      const blocks: Record<string, unknown>[] = [];
      // Every write the turn makes, journaled by the toolset's own db
      // wrappers (director/changes.js) and persisted as a `changes` block —
      // the same record the hosted handler writes, so the dock's Revert reads
      // one shape whichever runner answered.
      const journal: Record<string, unknown>[] = [];
      const paint = (text: string) => {
        if (!msgId) return;
        void supabase.from("chat_messages").update({
          content: [...blocks, { type: "text", text }],
        }).eq("id", msgId);
      };
      // Built HERE and not by the caller: it needs the thread and the brief,
      // and both are decided a few lines up. `onBrief` is what moves the panel
      // beside the conversation while the turn is still running — the hosted
      // route sends its own `brief` event for the same reason.
      const kit = opts.toolset?.({
        projectId: body.project_id, threadId,
        brief,
        onBrief: (b) => onEvent({ t: "brief", brief: b }),
      });
      try {
        const { text } = await runLocalDirectorTurn({
          system: persona, history, model: localModel,
          // Undefined for the Ollama path, which is its own default — the loop
          // is provider-agnostic and this is the one call that is not.
          chat: desk.chat,
          toolset: kit && { tools: kit.tools, names: kit.names, run: kit.run },
          ctx: kit ? kit.ctx : {
            projectId: body.project_id, episodeId: body.episode_id ?? null,
            backendId: desk.backendId, persona, settings, journal,
            // Whether a tool may queue its worker-side half onto the lane THIS
            // machine serves rather than the pod's. `redraw_panels` composes
            // panel prompts in the bundled pipeline Python, so with an engine
            // installed the whole redraw — composition and, on a studio-hosted
            // image model, the renders — happens with the pod stopped. Read
            // once per turn and passed through ctx, because tools.js is also
            // loaded by a serverless function that can resolve none of this.
            plannerHere: await (async () => {
              try {
                const { plannerInstalled } = await import("./desktopPlanner.ts");
                return await plannerInstalled();
              } catch { return false; }   // web build: no pipeline Python here
            })(),
          },
          onEvent: (e) => {
            if (e.t !== "tool" || !e.name) return;
            // The RESULT is kept, compactly: it is what draws the "queued ·
            // job …" receipt and the choice buttons on a reloaded transcript,
            // and this path used to store the bare name and lose both.
            const compact = compactResult(e.result);
            blocks.push(e.status === "run"
              ? { type: "tool_use", name: e.name }
              : { type: "tool_result", name: e.name, ...(compact ? { result: compact } : {}) });
            paint("");
            onEvent({ t: "tool", name: e.name, status: e.status ?? "ok",
                      ...(compact?.block_id && compact?.job_id
                        ? { block_id: String(compact.block_id), job_id: String(compact.job_id) }
                        : {}) });
          },
        });
        if (msgId) {
          await supabase.from("chat_messages").update({
            content: [...blocks,
                      ...(hasChanges(journal) ? [{ type: "changes", ops: journal }] : []),
                      { type: "text", text }],
            streaming: false,
          }).eq("id", msgId);
        }
        onEvent({ t: "done", message_id: msgId ?? undefined, backend: desk.backendId });
        return;
      } catch (e) {
        // The reason belongs in the transcript, not only in a console: a bare
        // failed turn sends people asking what broke when we know exactly.
        const why = e instanceof Error ? e.message : String(e);
        if (msgId) {
          await supabase.from("chat_messages").update({
            streaming: false,
            content: [...blocks, { type: "text", text: `⚠ ${why.slice(0, 400)}` }],
          }).eq("id", msgId);
        }
        onEvent({ t: "error", message: why });
        return;
      }
    }
  }

  // NOTHING HERE COULD ANSWER, and there is nowhere else to ask. The cloud
  // build parked the turn on a queue a worker elsewhere read; this build has
  // one plane, so a turn nothing can answer is REFUSED with the two things
  // that would fix it rather than sitting `queued` for good.
  //
  // Under `describeDirectorError`'s 160-character cap, for the reason
  // `LOCAL_PROJECT_REFUSAL` states: past it the banner elides the half that
  // names the fix.
  throw new Error(
    "No model on this machine can answer that yet — add a provider key, or "
    + "install a local model in the engine window.");
}

/** The wizard's brief interview, answered on this machine.
 *
 *  IT CARRIES THE INTERVIEW'S OWN THREE TOOLS, and for its whole life it did
 *  not. `queueLocalDirectorTurn` hands out the DIRECTOR's forty by default, so
 *  a turn answered here was offered `add_scene` and `plan_storyboard` — which
 *  the interview's contract forbids it to touch — and not `note_brief`, which
 *  is the one tool it exists to call and the only thing that writes
 *  `chat_threads.brief`. It talked, and the panel beside it stayed empty.
 *
 *  It is also the only place the interview can happen for a project whose rows
 *  are a file on this machine: `/api/director/brief` looks the project up in
 *  Supabase and answers 404 for one.
 *
 *  When nothing here can answer, the queued path still hands the turn to the
 *  pod, whose `director_tools.py` has `note_brief` of its own. */
export async function queueLocalBriefTurn(
  body: BriefRequest & { project?: DirectorProject },
  onEvent: (ev: DirectorEvent) => void
): Promise<void> {
  return queueLocalDirectorTurn(body, onEvent, {
    kind: "wizard", resume: body.resume,
    toolset: (info) => ({
      tools: BRIEF_TOOLS,
      names: BRIEF_TOOL_NAMES,
      // `info` IS the tool context — same four fields, by construction, so
      // there is nothing to keep in step between the two.
      ctx: info as unknown as Record<string, unknown>,
      run: (name, input, ctx) => runBriefTool(name, input, ctx as unknown as BriefToolCtx),
    }),
    systemExtra: (brief) => interviewSystem({
      project: {
        title: body.project?.title ?? undefined,
        medium: body.persona?.medium ?? body.project?.medium ?? undefined,
        style: body.project?.style ?? undefined,
        genre: body.project?.genre ?? [],
      },
      experts: body.experts ?? [],
      lengthS: body.length_s,
      brief,
    }),
  });
}

/* ────────────────────────────────────────────────── prompt enhancement ── */

export interface EnhanceRequest {
  prompt: string;
  /** Selects the guide's ruleset. "music" is the composer's word for a
   *  `kind: "audio"` catalog row — prompt_guides keys on this, not on the
   *  catalog column. */
  kind: "image" | "video" | "music" | "sfx" | "v2a";
  /** WHAT is being rewritten, which decides the whole system prompt.
   *
   *  "prompt" (the default, and every caller written before this) is a
   *  generation prompt: it gets the model's own guide, and on an H3 family it
   *  comes back as the six-section envelope because that guide defines the
   *  output FORMAT.
   *
   *  "edit" is a video EDIT INSTRUCTION — the retake modal's Edit brief. The
   *  studio compiles the envelope AROUND those words
   *  (`h3_prompt.compile_video_edit`), so an envelope returned here would be
   *  nested inside another one. `editSystem` asks for the clause instead, and
   *  the prompt-shaping context (the vendor doc, the style guide, the
   *  alignment line, the pass duration) is deliberately NOT sent with it. */
  shape?: "prompt" | "edit";
  /** model_catalog.family — what selects the guide */
  family?: string | null;
  mode?: string | null;
  mode_label?: string | null;
  model_label?: string | null;
  /** the project style guide, so the rewrite stays inside the look */
  style?: string | null;
  refs?: number;
  has_start?: boolean;
  /** the pass length, so cut timestamps can be told to fall inside it */
  duration_ms?: number;
  /** H3 keyframe modes open on a fixed vendor instruction line — we compute
   *  it rather than asking the model to remember the wording and the clock */
  alignment?: string;
  project_id?: string | null;
  backend?: string;
}

export interface EnhanceResult {
  prompt: string;
  guide: { id: string; label: string; exact: boolean };
  backend: string;
  cost_usd?: number;
  /** every backend that failed on the way here, oldest first — a rewrite that
   *  arrived on the second choice is still a rewrite, but the caller says so */
  fell_back?: { from: string; to: string; reason: string }[];
}

/** Which guide a generation would be rewritten against, for UI copy. */
export function enhanceGuide(sel: { family?: string | null; kind: string; mode?: string | null }) {
  return guideFor({ family: sel.family ?? undefined, kind: sel.kind, mode: sel.mode ?? undefined }) as {
    id: string; label: string; rules: string; note: string;
    format: string; docs: string[]; exact: boolean;
  };
}

/** The vendor instruction line an H3 keyframe mode must open with. */
export function enhanceAlignment(mode: string | null | undefined, durationMs: number): string {
  return h3AlignmentLine(mode ?? "", durationMs) as string;
}

/**
 * ONE TOOL-FREE TURN on whichever model this machine can reach.
 *
 * Every caller here is the same shape: a system prompt, one user message, and
 * a string back — a prompt rewrite, a workflow substitution. It is NOT the
 * director's loop (that one carries forty tools and writes rows), so it lives
 * beside it rather than inside it.
 *
 * A CHOSEN backend is honoured and only then is a stored key spent; reaching
 * for one because it happens to be there would bill somebody for a call they
 * expected to be free, which is the Ollama path's whole promise. Null means
 * nothing here could answer — the caller says so rather than substituting.
 */
export async function localOneShot(
  system: string, user: string, backend?: string,
): Promise<{ text: string; backend: string } | null> {
  const chosen = byokBackendProvider(backend);
  if (chosen) {
    await refreshByok();
    if (!hasKey(chosen)) return null;
    const model = byokModelFor(backend);
    const out = await chatFor(chosen, model)({
      system, model, messages: [{ role: "user", content: user }],
    });
    const text = (out?.content ?? "").trim();
    return text ? { text, backend: byokBackendId(chosen, model) } : null;
  }
  const model = await desktopLlm();
  if (!model) return null;
  const text = ((await ollamaChat({
    system, model, messages: [{ role: "user", content: user }],
  })) ?? "").trim();
  return text ? { text, backend: "ollama-desktop" } : null;
}

/** Can THIS MACHINE answer a one-shot turn on a local model right now?
 *
 *  Desktop only, and deliberately a question about the model rather than about
 *  the app: an Ollama that is running but holds nothing we can use is not
 *  ready, and pretending otherwise turns a two-second rewrite into a failed
 *  one. Returns the tag to use, or null. */
async function desktopLlm(): Promise<string | null> {
  if (!isDesktop()) return null;
  try {
    return installedDirectorModel(await ollamaStatus());
  } catch {
    return null;
  }
}

/** The rewrite, run here. Returns null when this machine cannot, so every
 *  caller falls through to the pod rather than failing.
 *
 *  ONE HONEST DIFFERENCE FROM THE POD, stated rather than hidden: the vendor
 *  guides in `director/knowledge/` are read off disk by whoever runs the turn,
 *  and the browser deliberately does not bundle them (they run to 39KB). So a
 *  desktop rewrite is grounded in the guide's RULES, which `enhanceSystem`
 *  already carries inline, and not in the vendor's full documentation. That is
 *  a smaller difference than it sounds — the rules are the part that says what
 *  a good prompt looks like — but it is a difference, and `fell_back` says so.
 */
async function desktopEnhance(
  body: EnhanceRequest,
  system: string,
  guide: { id: string; label: string; exact: boolean },
  fellBack?: EnhanceResult["fell_back"],
): Promise<EnhanceResult | null> {
  // A CHOSEN backend is honoured, and only then does a stored key get spent.
  // Reaching for one because it happens to be there would bill the user for a
  // rewrite they expected to be free — the Ollama path's whole promise.
  const chosen = byokBackendProvider(body.backend);
  if (chosen) {
    await refreshByok();
    if (!hasKey(chosen)) return null;             // let the pod have it
    const model = byokModelFor(body.backend);
    const out = await chatFor(chosen, model)({
      system, model, messages: [{ role: "user", content: body.prompt }],
    });
    const prompt = (out?.content ?? "").trim();
    if (!prompt) return null;
    return {
      prompt, backend: byokBackendId(chosen, model), guide,
      // The provider bills this and does not report a figure on a text turn,
      // so it is left UNSET rather than written as 0 — a zero here would sit
      // in the Costs page as a claim that it was free.
      cost_usd: undefined,
      fell_back: fellBack,
    };
  }
  const model = await desktopLlm();
  if (!model) return null;
  const out = await ollamaChat({
    system, model,
    messages: [{ role: "user", content: body.prompt }],
  });
  const prompt = (out ?? "").trim();
  if (!prompt) return null;      // an empty turn is not a rewrite; let the pod try
  return {
    prompt, backend: "ollama-desktop",
    guide, cost_usd: 0,
    fell_back: fellBack,
  };
}

/** Local rewrite: an ordinary llm_task, then wait for the row.
 *
 *  Polled rather than subscribed on purpose — realtime here is one shared
 *  channel built by useLiveQuery, and a one-shot request that lives for a few
 *  seconds has no business opening its own (see the realtime gotcha). */
async function queueLocalEnhance(
  body: EnhanceRequest,
  opts: { signal?: AbortSignal; waitMs?: number; fellBack?: EnhanceResult["fell_back"] } = {}
): Promise<EnhanceResult> {
  const { signal, waitMs = 180_000 } = opts;
  const guide = enhanceGuide({ family: body.family, kind: body.kind, mode: body.mode });
  // Everything except the vendor guide itself: those files run to 39KB and the
  // pod already has them on disk, so the payload names them and the worker
  // appends them (`guide_docs`). Same reasoning as personas travelling built —
  // one source of truth, assembled wherever the turn actually runs.
  // An EDIT brief is a different job with a different output, so it gets a
  // different system prompt and none of the prompt-shaping context — see
  // `editSystem`. It also names no vendor doc: 39KB of envelope documentation
  // is the surest way to be handed an envelope.
  const edit = body.shape === "edit";
  const system = (edit
    ? editSystem({ refs: body.refs ?? 0 })
    : enhanceSystem({
      guide, kind: body.kind,
      mode: body.mode ?? undefined, modeLabel: body.mode_label ?? undefined,
      alignment: body.alignment ?? undefined, durationMs: body.duration_ms ?? 0,
      style: body.style ?? undefined, refs: body.refs ?? 0, hasStart: body.has_start,
    })) as string;

  // This machine first. Same model family, no queue, no $3.36/hr box to wake
  // — and on a LOCAL project the pod cannot answer at all, because its rows
  // live in a file the worker has never seen.
  const here = await desktopEnhance(body, system, guide, opts.fellBack);
  if (here) return here;

  // NOTHING HERE COULD ANSWER. The cloud build queued the rewrite for a
  // worker on another machine; there is no such worker, so this names the two
  // things that would work instead of parking a job on a queue nobody serves.
  // Kept under `describeDirectorError`'s 160-character cap — past it the
  // banner elides the half that names the fix.
  throw new Error(
    "No model on this machine can rewrite that yet — add a provider key, or "
    + "install a local model in the engine window.");
}

/** One-click prompt rewrite against the selected model's stored guide.
 *
 *  Answered on this machine — a key of your own, or the Ollama on loopback —
 *  and refused with a reason when neither is there. The cloud build had a
 *  server-side route for this and a fallback chain between the two; with one
 *  plane left there is nothing to fall back TO, so a failure is reported
 *  rather than retried somewhere else.
 *
 *  `fell_back` survives in the result shape because every caller renders it,
 *  and a rewrite answered here simply reports none. */
export async function enhancePrompt(
  body: EnhanceRequest,
  opts: { signal?: AbortSignal } = {}
): Promise<EnhanceResult> {
  return queueLocalEnhance(body, { signal: opts.signal });
}

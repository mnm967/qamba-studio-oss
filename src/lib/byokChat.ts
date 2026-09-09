// The director, the one-shot interview and the enhance button, on your own key.
//
// ONE LOOP, FOUR BACKENDS. `runLocalDirectorTurn` already ran the whole
// forty-tool director against Ollama on this machine; the only part of it that
// was provider-specific was the model call, so that is now injected and this
// file supplies the other three. Every vendor's wire format is translated back
// to the ONE shape that loop reads — `{content, tool_calls}` — so the round
// discipline, the loose-tool-call recovery and the out-of-rounds summary are
// shared rather than reimplemented per provider.
//
// THE CONVERSATION IS TRANSLATED, NOT ACCUMULATED PER VENDOR. The loop keeps a
// neutral history and each adapter converts the whole thing on every turn.
// That costs a little work per round and buys the thing that matters: a
// backend can be swapped mid-thread, and there is exactly one place a message
// can be dropped.
//
// TOOL RESULTS ARE PAIRED BY ORDER, because the neutral history has no ids —
// the loop pushes one assistant message carrying N tool calls and then exactly
// N `role: "tool"` messages, in the same order. Anthropic and Gemini both
// require the pairing to be explicit, so it is reconstructed here and pinned
// by tests: a mispaired result is a model answering the wrong question with no
// error anywhere.
import { byokJson } from "./byok.ts";
import type { ChatTurnReq } from "./localDirector.ts";

/** Ollama's message shape, which is what the loop reads. */
export interface TurnMessage {
  content?: string;
  thinking?: string;
  tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
}

/** An OpenAI-shaped tool, which is what `asOllamaTools` already produces. */
interface FnTool {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
}

/** The neutral history entries the loop pushes. */
interface NeutralMsg {
  role?: string;
  content?: string;
  tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
}

const asObj = (raw: unknown): Record<string, unknown> => {
  if (typeof raw === "string") {
    try { return JSON.parse(raw || "{}") as Record<string, unknown>; } catch { return {}; }
  }
  return (raw ?? {}) as Record<string, unknown>;
};

/* ── Anthropic ──────────────────────────────────────────────────────────── */

export function anthropicTools(tools: FnTool[]): unknown[] {
  return tools.map((t) => ({
    name: t.function?.name,
    description: t.function?.description,
    // `input_schema`, not `parameters` — Anthropic rejects the OpenAI spelling
    // outright, so this is a 400 rather than a silently tool-less turn.
    input_schema: t.function?.parameters ?? { type: "object", properties: {} },
  }));
}

/**
 * The neutral history as Anthropic content blocks.
 *
 * Each assistant tool call becomes a `tool_use` with a synthetic id, and the
 * `role: "tool"` messages that follow are consumed in order as `tool_result`
 * blocks carrying the matching id. Anthropic requires every `tool_use` to be
 * answered in the NEXT user message, so the results are grouped into one.
 */
export function anthropicMessages(convo: NeutralMsg[]): unknown[] {
  const out: { role: string; content: unknown }[] = [];
  let pending: string[] = [];        // ids awaiting a result, in order
  let results: unknown[] = [];

  const flush = () => {
    if (results.length) { out.push({ role: "user", content: results }); results = []; }
    pending = [];
  };

  for (const m of convo) {
    if (m.role === "tool") {
      const id = pending.shift();
      // A result with nothing to answer is dropped rather than sent: Anthropic
      // 400s a `tool_result` whose id it has not seen, which would fail the
      // whole turn over one stray message.
      if (id) results.push({ type: "tool_result", tool_use_id: id, content: m.content ?? "" });
      continue;
    }
    flush();
    if (m.role === "assistant" && m.tool_calls?.length) {
      const blocks: unknown[] = [];
      if (m.content?.trim()) blocks.push({ type: "text", text: m.content });
      m.tool_calls.forEach((c, i) => {
        const id = `call_${out.length}_${i}`;
        pending.push(id);
        blocks.push({ type: "tool_use", id, name: c.function?.name, input: asObj(c.function?.arguments) });
      });
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    // Anthropic refuses an empty content block, and the loop can push an
    // assistant message with neither text nor calls.
    const text = m.content ?? "";
    if (!text.trim()) continue;
    out.push({ role: m.role === "assistant" ? "assistant" : "user", content: text });
  }
  flush();
  return out;
}

interface AnthropicReply {
  content?: { type?: string; text?: string; name?: string; input?: unknown }[];
  stop_reason?: string;
}

export async function anthropicTurn(
  req: ChatTurnReq, http = byokJson,
): Promise<TurnMessage> {
  const body: Record<string, unknown> = {
    model: req.model,
    // Required by the API, unlike every other provider here — omitting it is
    // a 400 that names the field rather than the key.
    max_tokens: 4096,
    system: req.system,
    messages: anthropicMessages(req.messages as NeutralMsg[]),
  };
  if (req.tools?.length) body.tools = anthropicTools(req.tools as FnTool[]);
  const r = await http<AnthropicReply>("anthropic", "/v1/messages", { method: "POST", body });
  const blocks = r.content ?? [];
  return {
    content: blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
    tool_calls: blocks.filter((b) => b.type === "tool_use")
      .map((b) => ({ function: { name: b.name, arguments: b.input } })),
  };
}

/* ── OpenAI ─────────────────────────────────────────────────────────────── */

interface OpenAiReply {
  choices?: { message?: { content?: string | null;
                          tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[];
}

/** OpenAI needs the same positional pairing Anthropic does — a `tool` message
 *  carries a `tool_call_id`, and the neutral history has none. */
export function openaiMessages(convo: NeutralMsg[], system: string): unknown[] {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }];
  let pending: string[] = [];
  for (const m of convo) {
    if (m.role === "tool") {
      const id = pending.shift();
      if (id) out.push({ role: "tool", tool_call_id: id, content: m.content ?? "" });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      pending = m.tool_calls.map((_c, i) => `call_${out.length}_${i}`);
      out.push({
        role: "assistant",
        content: m.content ?? null,
        tool_calls: m.tool_calls.map((c, i) => ({
          id: pending[i], type: "function",
          function: { name: c.function?.name, arguments: JSON.stringify(asObj(c.function?.arguments)) },
        })),
      });
      continue;
    }
    pending = [];
    out.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content ?? "" });
  }
  return out;
}

/** Which endpoint serves this model's function tools. Looked up by the id the
 *  VENDOR takes, so it answers for a model reached by a bare
 *  `byok:<provider>` id and a stored default too — neither of which the picker
 *  ever sees. Prefix-matched, so a dated snapshot of the same model routes the
 *  same way. */
export function toolTransport(model: string): "chat" | "responses" {
  const m = CHAT_MODELS.find(
    (d) => d.toolTransport && String(model || "").startsWith(d.api));
  return m?.toolTransport ?? "chat";
}

export async function openaiTurn(req: ChatTurnReq, http = byokJson): Promise<TurnMessage> {
  // ROUTED ON THE TOOLS, NOT ON THE MODEL. A turn that carries none works on
  // chat completions for every model here, and `enhance` and the staged
  // planner are exactly that — so the branch is taken only where it has to be.
  if (req.tools?.length && toolTransport(req.model) === "responses") {
    return openaiResponsesTurn(req, http);
  }
  const body: Record<string, unknown> = {
    model: req.model,
    messages: openaiMessages(req.messages as NeutralMsg[], req.system),
  };
  if (req.tools?.length) {
    body.tools = req.tools;
    // The pod's own OpenAI path documents this: `/v1/chat/completions` refuses
    // function tools from a reasoning model unless reasoning is explicitly
    // off, and measured, only "none" is accepted. Tool-carrying requests ONLY
    // — a plain turn keeps the model's own reasoning.
    body.reasoning_effort = "none";
  }
  const r = await http<OpenAiReply>("openai", "/v1/chat/completions", { method: "POST", body });
  const msg = r.choices?.[0]?.message;
  return {
    content: msg?.content ?? "",
    tool_calls: (msg?.tool_calls ?? []).map((c) => ({
      function: { name: c.function?.name, arguments: c.function?.arguments },
    })),
  };
}

/* ── OpenAI: the Responses API ──────────────────────────────────────────── */
//
// A SECOND OPENAI DIALECT, for one model and one reason. GPT-6 Astra rejects
// `reasoning_effort: "none"`, and that is the only value chat completions
// accepts alongside function tools from a reasoning model — so the director's
// forty tools reach it here or nowhere.
//
// Three things it does NOT share with the dialect above, each a silent wrong
// answer if copied across:
//   * a tool is FLAT (`{type, name, description, parameters}`), not nested
//     under `function`. Nested, the key is one the endpoint does not declare.
//   * the system prompt is `instructions`, a sibling of `input` — there is no
//     system ROLE to put it in.
//   * a tool call and its result are INPUT ITEMS in the one flat `input`
//     array, paired by `call_id`, rather than an assistant message with a
//     `tool_calls` array followed by `tool` messages.

/** Anthropic/OpenAI function defs -> Responses function tools. */
export function responsesTools(tools: FnTool[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    name: t.function?.name,
    description: t.function?.description,
    parameters: t.function?.parameters ?? { type: "object", properties: {} },
  }));
}

/**
 * The neutral history as Responses input items.
 *
 * Same positional pairing as `openaiMessages` and for the same reason — the
 * loop's history has no ids, so the `call_id` linking a call to its result is
 * minted here and has to be minted CONSISTENTLY within one request. A counter
 * rather than a length, because the assistant's own text is pushed between
 * the map and the calls and a length would shift under it.
 */
export function responsesInput(convo: NeutralMsg[]): unknown[] {
  const out: Record<string, unknown>[] = [];
  let pending: string[] = [];
  let n = 0;
  for (const m of convo) {
    if (m.role === "tool") {
      const id = pending.shift();
      // A result with nothing to answer is dropped rather than sent: an
      // unmatched `call_id` is a 400 that fails the whole turn over one stray
      // message, which is `anthropicMessages`' rule one dialect over.
      if (id) out.push({ type: "function_call_output", call_id: id, output: m.content ?? "" });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      pending = m.tool_calls.map(() => `call_${n++}`);
      if (m.content?.trim()) out.push({ role: "assistant", content: m.content });
      m.tool_calls.forEach((c, i) => {
        out.push({
          type: "function_call", call_id: pending[i], name: c.function?.name,
          // A STRING, always. The loop's history carries whatever the last
          // adapter returned — an object from Ollama, a string from chat
          // completions — and this field is documented as JSON text.
          arguments: JSON.stringify(asObj(c.function?.arguments)),
        });
      });
      continue;
    }
    pending = [];
    const text = m.content ?? "";
    if (!text.trim()) continue;
    out.push({ role: m.role === "assistant" ? "assistant" : "user", content: text });
  }
  return out;
}

interface ResponsesReply {
  output?: {
    type?: string; name?: string; arguments?: string; call_id?: string;
    content?: { type?: string; text?: string }[];
  }[];
}

/** Read the assistant's text and its calls out of a Responses `output` array.
 *  Shared with the streamed path, whose `response.completed` event carries the
 *  identical array — so the two cannot disagree about what a turn said. */
export function responsesMessage(out: ResponsesReply["output"]): TurnMessage {
  const items = out ?? [];
  return {
    // Every item that is not a message or a call — `reasoning` above all — is
    // ignored rather than concatenated: its content is not the reply.
    content: items.filter((i) => i.type === "message")
      .flatMap((i) => i.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text ?? "").join(""),
    tool_calls: items.filter((i) => i.type === "function_call")
      .map((i) => ({ function: { name: i.name, arguments: i.arguments } })),
  };
}

export async function openaiResponsesTurn(
  req: ChatTurnReq, http = byokJson,
): Promise<TurnMessage> {
  const body: Record<string, unknown> = {
    model: req.model,
    instructions: req.system,
    input: responsesInput(req.messages as NeutralMsg[]),
    // STATELESS, DELIBERATELY. This endpoint stores the response for 30 days
    // by default, and what it would be storing is the user's own storyboard,
    // bible and conversation on a third party's servers. The loop re-sends
    // the whole history every round anyway, so there is nothing to gain.
    store: false,
  };
  if (req.tools?.length) {
    body.tools = responsesTools(req.tools as FnTool[]);
    body.tool_choice = "auto";
  }
  const r = await http<ResponsesReply>("openai", "/v1/responses", { method: "POST", body });
  return responsesMessage(r.output);
}

/* ── Google Gemini ──────────────────────────────────────────────────────── */

interface GeminiReply {
  candidates?: { content?: { parts?: { text?: string;
                                       functionCall?: { name?: string; args?: unknown } }[] } }[];
}

/** Gemini's roles are `user` and `model`, and a tool result is a `user` turn
 *  carrying a `functionResponse` part. Names rather than ids, so the pairing
 *  is by NAME as well as by order. */
export function geminiContents(convo: NeutralMsg[]): unknown[] {
  const out: Record<string, unknown>[] = [];
  let pending: string[] = [];
  for (const m of convo) {
    if (m.role === "tool") {
      const name = pending.shift();
      if (name) {
        out.push({ role: "user", parts: [{ functionResponse: {
          name, response: { result: m.content ?? "" } } }] });
      }
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      pending = m.tool_calls.map((c) => c.function?.name ?? "");
      const parts: unknown[] = [];
      if (m.content?.trim()) parts.push({ text: m.content });
      for (const c of m.tool_calls) {
        parts.push({ functionCall: { name: c.function?.name, args: asObj(c.function?.arguments) } });
      }
      out.push({ role: "model", parts });
      continue;
    }
    pending = [];
    const text = m.content ?? "";
    if (!text.trim()) continue;
    out.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text }] });
  }
  return out;
}

export async function geminiTurn(req: ChatTurnReq, http = byokJson): Promise<TurnMessage> {
  const body: Record<string, unknown> = {
    // `systemInstruction`, not a system message — Gemini has no system role,
    // and a system prompt sent as a user turn is one the model may argue with.
    systemInstruction: { parts: [{ text: req.system }] },
    contents: geminiContents(req.messages as NeutralMsg[]),
  };
  if (req.tools?.length) {
    body.tools = [{
      functionDeclarations: (req.tools as FnTool[]).map((t) => ({
        name: t.function?.name,
        description: t.function?.description,
        parameters: t.function?.parameters ?? { type: "object", properties: {} },
      })),
    }];
  }
  const r = await http<GeminiReply>("google",
    `/v1beta/models/${req.model}:generateContent`, { method: "POST", body });
  const parts = r.candidates?.[0]?.content?.parts ?? [];
  return {
    content: parts.filter((p) => p.text).map((p) => p.text).join(""),
    tool_calls: parts.filter((p) => p.functionCall)
      .map((p) => ({ function: { name: p.functionCall?.name, arguments: p.functionCall?.args } })),
  };
}

/* ── choosing one ───────────────────────────────────────────────────────── */

export const CHAT_PROVIDERS = ["anthropic", "openai", "google"] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

export const isChatProvider = (p: string): p is ChatProvider =>
  (CHAT_PROVIDERS as readonly string[]).includes(p);

/** One chat model the picker offers, on either plane. */
export interface ChatModelDef {
  provider: ChatProvider;
  /** the id the VENDOR takes — what a BYOK turn actually sends */
  api: string;
  /** display name, shared with the studio row so the two read as one model */
  model: string;
  /** compact form for the cramped dock trigger */
  short: string;
  /** what the model is for; the tier heading and the chip say whose key */
  hint: string;
  /**
   * WHICH OPENAI ENDPOINT SERVES THIS MODEL'S FUNCTION TOOLS. Absent means
   * `/v1/chat/completions`, which is every model here but one.
   *
   * GPT-6 Astra is the exception and the reason this field exists: it rejects
   * `reasoning_effort: "none"`, which is the one value that gets function
   * tools past chat completions on a reasoning model, so a tool-carrying turn
   * has no legal shape there at all. The vendor's answer is `/v1/responses`,
   * and `openaiResponsesTurn` is it.
   *
   * A fact about the TRANSPORT rather than about the model, which is why it
   * lives beside `api` — the other thing only this table knows. Tool-LESS
   * calls (`enhance`, the staged planner) are unaffected and stay on chat
   * completions whatever this says: they work there today, and moving a
   * working path is a risk this buys nothing with.
   */
  toolTransport?: "responses";
}

/**
 * ONE ROW PER MODEL, not one per provider.
 *
 * This section used to be "Claude", "GPT", "Gemini" — three rows, each running
 * whatever `chatModelFor` happened to have stored — so the plane whose whole
 * promise is "your key, your choice" was the one with no choice in it, and
 * Opus over Haiku was not something anyone could pick.
 *
 * `api` IS THE VENDOR'S OWN ID and there is nowhere else to read it from: the
 * request is made from this machine, so the string that names the model has to
 * be here. Every one was checked against the vendor's published model list on
 * the date in the comment beside it; an id that has been withdrawn 404s on the
 * first turn, which is why the defaults are the GA ones rather than the
 * flagships.
 */
export const CHAT_MODELS: ChatModelDef[] = [
  // Checked against Anthropic's own model table on 2026-09-07: `claude-fable-5-1`
  // is the API id AND the alias (dateless ids from the 4.6 generation on are
  // their own pinned snapshot), $10/$50 per MTok, 1M context, 128K output,
  // adaptive thinking always on at effort `high`. It sits above Opus 5 there,
  // which is why it leads here.
  { provider: "anthropic", api: "claude-fable-5-1",
    model: "Claude Fable 5.1", short: "Fable 5.1",
    hint: "Anthropic's model for demanding reasoning and long-horizon agentic "
        + "work — the slowest and dearest of the four, on an Anthropic API key." },
  { provider: "anthropic", api: "claude-opus-5",
    model: "Claude Opus 5", short: "Opus 5",
    hint: "The largest Claude model, billed per token on an Anthropic API key." },
  { provider: "anthropic", api: "claude-sonnet-5",
    model: "Claude Sonnet 5", short: "Sonnet 5",
    hint: "Faster and cheaper than Opus 5 for most editing turns, on the same "
        + "Anthropic API key." },
  { provider: "anthropic", api: "claude-haiku-4-5-20251001",
    model: "Claude Haiku 4.5", short: "Haiku 4.5",
    hint: "The fastest Claude model with the full tool set — quick edits and "
        + "short turns, on the same Anthropic API key." },
  // GPT-6 ASTRA'S TOOLS GO THROUGH /v1/responses, which is read off OpenAI's
  // own model page rather than guessed: it serves both endpoints, its
  // `reasoning.effort` takes low/medium/high/xhigh (max on Responses only)
  // and REJECTS `none` — the exact value chat completions needs before it
  // will accept function tools from a reasoning model. So the director's
  // forty tools have no legal shape on chat completions here, and the vendor's
  // own answer is the endpoint `openaiResponsesTurn` speaks.
  { provider: "openai", api: "gpt-6-astra",
    model: "GPT-6 Astra", short: "Astra",
    toolTransport: "responses",
    hint: "OpenAI's frontier model — 1.05M context, 128K output — on an "
        + "OpenAI-compatible API key. Tool turns go through its Responses "
        + "endpoint." },
  { provider: "openai", api: "gpt-5.6-luna",
    model: "GPT-5.6 Luna", short: "Luna",
    hint: "Runs on an OpenAI-compatible API key." },
  { provider: "openai", api: "gpt-5.6-sol",
    model: "GPT-5.6 Sol", short: "Sol",
    hint: "Runs on an OpenAI-compatible API key." },
  { provider: "openai", api: "gpt-5.6-terra",
    model: "GPT-5.6 Terra", short: "Terra",
    hint: "Runs on an OpenAI-compatible API key." },
  // Checked against Google's own model list on 2026-09-06. Two things that
  // list settled: `gemini-3-pro` — this file's own default until now — is on
  // it NOWHERE, so the default was already the stale-id 404 the comment below
  // warns about; and the only Pro-tier Gemini 3 id published is a PREVIEW one,
  // which is why the default here is the GA Flash rather than the flagship.
  { provider: "google", api: "gemini-3.1-pro-preview",
    model: "Gemini 3.1 Pro", short: "3.1 Pro",
    hint: "Google's most capable Gemini — and a preview id, so it can be "
        + "withdrawn without notice." },
  { provider: "google", api: "gemini-3.8-flash",
    model: "Gemini 3.8 Flash", short: "3.8 Flash",
    hint: "Generally available, and the Gemini Google builds for long agentic "
        + "runs — which is what a forty-tool director turn is." },
  { provider: "google", api: "gemini-3.5-flash-lite",
    model: "Gemini 3.5 Flash-Lite", short: "Flash-Lite",
    hint: "The cheapest and quickest Gemini — short turns rather than long "
        + "tool chains." },
];

/**
 * The model to use when the user has not picked one — a bare `byok:<provider>`
 * id, which is what every thread opened before the picker named models still
 * carries.
 *
 * Ids the repo already names: `claude-opus-5` is `ANTHROPIC_MODEL`'s default
 * and `gpt-5.6-terra` is `DEFAULT_PIPELINE_MODEL`. Google's was NOT one this
 * repo had ever named and had gone stale (see `CHAT_MODELS` above), so it is
 * the GA Flash now rather than a Pro id the API no longer publishes — a
 * default is the one model nobody chose, so it should be the one least likely
 * to be withdrawn.
 */
export const DEFAULT_CHAT_MODEL: Record<ChatProvider, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5.6-terra",
  google: "gemini-3.8-flash",
};

/** How each provider lists what a key can see, and where the ids are. */
const MODEL_LIST: Record<ChatProvider, { path: string; pick: (b: unknown) => string[] }> = {
  anthropic: {
    path: "/v1/models",
    pick: (b) => ((b as { data?: { id?: string }[] })?.data ?? [])
      .map((m) => m.id ?? "").filter(Boolean),
  },
  openai: {
    path: "/v1/models",
    pick: (b) => ((b as { data?: { id?: string }[] })?.data ?? [])
      .map((m) => m.id ?? "").filter(Boolean),
  },
  google: {
    path: "/v1beta/models",
    // `models/gemini-3-pro` — the API wants the bare name back in the URL.
    pick: (b) => ((b as { models?: { name?: string; supportedGenerationMethods?: string[] }[] })
      ?.models ?? [])
      .filter((m) => !m.supportedGenerationMethods
        || m.supportedGenerationMethods.includes("generateContent"))
      .map((m) => (m.name ?? "").replace(/^models\//, "")).filter(Boolean),
  },
};

/** Chat-capable model ids this key can see. Empty on any failure — a picker
 *  with no list falls back to the default, which is better than an error where
 *  a list was expected. */
export async function chatModels(provider: ChatProvider, http = byokJson): Promise<string[]> {
  try {
    const spec = MODEL_LIST[provider];
    const ids = spec.pick(await http<unknown>(provider, spec.path));
    // Image, audio, embedding and moderation rows are not chat models, and a
    // list with 60 of them in it is one nobody reads.
    return ids.filter((id) => !/embed|tts|whisper|image|audio|moderation|veo|imagen/i.test(id));
  } catch {
    return [];
  }
}

/** Bind a turn function to a provider and a model. */
export function chatFor(provider: ChatProvider, model: string) {
  const fn = provider === "anthropic" ? anthropicTurn
    : provider === "openai" ? openaiTurn : geminiTurn;
  return (req: ChatTurnReq) => fn({ ...req, model: model || DEFAULT_CHAT_MODEL[provider] });
}

/* ── as a director backend ──────────────────────────────────────────────── */

/** A backend id for one of the user's own keys. `byok:` rather than the bare
 *  provider so `isLocalBackend` can recognise the whole family in one test —
 *  these run in the browser like the Ollama one, not on the pod. */
export const BYOK_BACKEND = "byok:";

/**
 * `byok:<provider>` names the provider's stored default; `byok:<provider>:<api
 * model>` names one model outright, which is what every picker row is now.
 *
 * THE BARE FORM STAYS LEGAL, and not only for tidiness: `chat_threads.backend`
 * holds whatever answered a turn, so every thread opened before the picker
 * named models carries one — and a bare id that stopped parsing would reopen
 * those threads pointed at nothing.
 */
export const byokBackendId = (p: ChatProvider, model?: string) =>
  `${BYOK_BACKEND}${p}${model ? `:${model}` : ""}`;

/** The provider behind a backend id, or null when it is not a BYOK one. */
export function byokBackendProvider(id: string | null | undefined): ChatProvider | null {
  if (!id?.startsWith(BYOK_BACKEND)) return null;
  const p = id.slice(BYOK_BACKEND.length).split(":")[0];
  return isChatProvider(p) ? p : null;
}

/** The model an id names outright, or null for the bare provider form.
 *  Split on the FIRST colon only — a vendor id may carry one of its own
 *  (Ollama's `qwen3:27b` shape), and cutting it in half would send a model
 *  that does not exist. */
export function byokBackendModel(id: string | null | undefined): string | null {
  if (!byokBackendProvider(id)) return null;
  const rest = id!.slice(BYOK_BACKEND.length);
  const i = rest.indexOf(":");
  return i < 0 ? null : rest.slice(i + 1) || null;
}

/** Which chat model a BYOK backend uses. Stored per provider on this machine,
 *  because it is a property of the key rather than of a project — the same
 *  reasoning as the model visibility list next to it. */
const MODEL_KEY = "qamba.byok.chatModel";

export function chatModelFor(p: ChatProvider, store?: Pick<Storage, "getItem">): string {
  try {
    const s = store ?? (typeof localStorage === "undefined" ? null : localStorage);
    const raw = s?.getItem(MODEL_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    return map[p] || DEFAULT_CHAT_MODEL[p];
  } catch { return DEFAULT_CHAT_MODEL[p]; }
}

/** The model a backend id will actually send: what it names, else the stored
 *  per-provider default. The one lookup every caller should use — reading
 *  `chatModelFor` directly ignores the model the user picked. */
export function byokModelFor(id: string | null | undefined): string {
  const p = byokBackendProvider(id);
  if (!p) return "";
  return byokBackendModel(id) || chatModelFor(p);
}

export function setChatModelFor(p: ChatProvider, model: string, store?: Storage) {
  try {
    const s = store ?? (typeof localStorage === "undefined" ? null : localStorage);
    if (!s) return;
    const raw = s.getItem(MODEL_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    if (model) map[p] = model; else delete map[p];
    s.setItem(MODEL_KEY, JSON.stringify(map));
  } catch { /* a private window — the default still works this session */ }
}

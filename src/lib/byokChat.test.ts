import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anthropicMessages, anthropicTools, anthropicTurn, chatFor, chatModels,
  openaiResponsesTurn, responsesInput, responsesMessage, responsesTools, toolTransport,
  geminiContents, geminiTurn, openaiMessages, openaiTurn, DEFAULT_CHAT_MODEL,
  byokBackendId, byokBackendModel, byokModelFor, byokBackendProvider,
  CHAT_MODELS, CHAT_PROVIDERS,
  isChatProvider,
} from "./byokChat.ts";

/** The neutral history exactly as `runLocalDirectorTurn` builds it: a user
 *  turn, an assistant message carrying N tool calls, then N tool results in
 *  the same order. */
const CONVO = [
  { role: "user", content: "rename scene 3" },
  { role: "assistant", content: "", tool_calls: [
    { function: { name: "list_storyboard", arguments: {} } },
    { function: { name: "update_scene", arguments: { id: "S3", slug: "THE_PRESS" } } },
  ] },
  { role: "tool", content: '{"scenes":[]}' },
  { role: "tool", content: '{"ok":true}' },
];

const TOOLS = [{ type: "function", function: {
  name: "update_scene", description: "rename it",
  parameters: { type: "object", properties: { id: { type: "string" } } },
} }];

const say = (reply: unknown) => (async () => reply) as never;
function spy(reply: unknown) {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const http = (async (_p: string, path: string, init: { body?: unknown } = {}) => {
    seen.push({ path, body: (init.body ?? {}) as Record<string, unknown> });
    return reply;
  }) as never;
  return { http, seen };
}

/* ── Anthropic ──────────────────────────────────────────────────────────── */

test("anthropic tools use input_schema, which is the spelling it accepts", () => {
  const [t] = anthropicTools(TOOLS) as { name: string; input_schema: unknown }[];
  assert.equal(t.name, "update_scene");
  assert.deepEqual(t.input_schema, TOOLS[0].function.parameters);
  assert.equal("parameters" in (t as object), false,
    "the OpenAI spelling is a 400 here, not a silently tool-less turn");
});

test("each tool result is paired with the call it answers, in order", () => {
  const msgs = anthropicMessages(CONVO) as { role: string; content: unknown }[];
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user"]);
  const uses = (msgs[1].content as { type: string; id: string; name: string }[])
    .filter((b) => b.type === "tool_use");
  const results = (msgs[2].content as { type: string; tool_use_id: string; content: string }[]);
  assert.deepEqual(uses.map((u) => u.name), ["list_storyboard", "update_scene"]);
  // The pairing is the whole risk: mismatched, the model reads the storyboard
  // listing as the answer to the rename and nothing errors anywhere.
  assert.equal(results[0].tool_use_id, uses[0].id);
  assert.equal(results[1].tool_use_id, uses[1].id);
  assert.equal(results[0].content, '{"scenes":[]}');
  assert.equal(results[1].content, '{"ok":true}');
});

test("a tool result with nothing to answer is dropped, not sent", () => {
  // Anthropic 400s a tool_result whose id it has not seen, which would fail
  // the whole turn over one stray message.
  const msgs = anthropicMessages([{ role: "tool", content: "orphan" }]);
  assert.deepEqual(msgs, []);
});

test("an empty assistant message is dropped rather than sent as blank content", () => {
  const msgs = anthropicMessages([
    { role: "user", content: "hi" }, { role: "assistant", content: "   " },
  ]);
  assert.equal(msgs.length, 1);
});

test("anthropic sends max_tokens, which is required, and reads back both parts", async () => {
  const { http, seen } = spy({ content: [
    { type: "text", text: "Renamed it." },
    { type: "tool_use", name: "update_scene", input: { id: "S3" } },
  ] });
  const out = await anthropicTurn(
    { system: "you are the director", messages: CONVO, model: "claude-opus-5", tools: TOOLS }, http);
  assert.equal(seen[0].path, "/v1/messages");
  assert.equal(seen[0].body.max_tokens, 4096);
  assert.equal(seen[0].body.system, "you are the director");
  assert.equal(out.content, "Renamed it.");
  assert.deepEqual(out.tool_calls, [{ function: { name: "update_scene", arguments: { id: "S3" } } }]);
});

test("no tools means no tools key — a turn with none must not send an empty list", async () => {
  const { http, seen } = spy({ content: [{ type: "text", text: "ok" }] });
  await anthropicTurn({ system: "s", messages: [], model: "m" }, http);
  assert.equal("tools" in seen[0].body, false);
});

/* ── OpenAI ─────────────────────────────────────────────────────────────── */

test("openai pairs tool_call_id and puts the system prompt first", () => {
  const msgs = openaiMessages(CONVO, "you are the director") as
    { role: string; tool_call_id?: string; tool_calls?: { id: string }[] }[];
  assert.equal(msgs[0].role, "system");
  const ids = msgs.find((m) => m.tool_calls)!.tool_calls!.map((c) => c.id);
  const results = msgs.filter((m) => m.role === "tool");
  assert.deepEqual(results.map((m) => m.tool_call_id), ids);
});

test("openai arguments are a STRING, which is what that API takes", () => {
  const msgs = openaiMessages(CONVO, "s") as
    { tool_calls?: { function: { arguments: unknown } }[] }[];
  const args = msgs.find((m) => m.tool_calls)!.tool_calls![1].function.arguments;
  assert.equal(typeof args, "string");
  assert.deepEqual(JSON.parse(args as string), { id: "S3", slug: "THE_PRESS" });
});

test("reasoning is turned off ONLY on a tool-carrying turn", async () => {
  // Measured on the pod: /v1/chat/completions refuses function tools from a
  // reasoning model unless reasoning is explicitly off. A plain turn keeps it.
  const withTools = spy({ choices: [{ message: { content: "hi" } }] });
  await openaiTurn({ system: "s", messages: [], model: "m", tools: TOOLS }, withTools.http);
  assert.equal(withTools.seen[0].body.reasoning_effort, "none");

  const plain = spy({ choices: [{ message: { content: "hi" } }] });
  await openaiTurn({ system: "s", messages: [], model: "m" }, plain.http);
  assert.equal("reasoning_effort" in plain.seen[0].body, false);
});

test("openai reads a null content back as an empty string", async () => {
  const out = await openaiTurn({ system: "s", messages: [], model: "m" },
    say({ choices: [{ message: { content: null, tool_calls: [
      { id: "a", function: { name: "x", arguments: "{}" } }] } }] }));
  assert.equal(out.content, "");
  assert.equal(out.tool_calls?.length, 1);
});

/* ── Gemini ─────────────────────────────────────────────────────────────── */

test("gemini uses model/user roles and answers a call BY NAME", () => {
  const c = geminiContents(CONVO) as { role: string; parts: Record<string, never>[] }[];
  assert.deepEqual(c.map((x) => x.role), ["user", "model", "user", "user"]);
  assert.equal(c[1].parts.length, 2, "two calls, no leading text");
  assert.equal((c[2].parts[0] as never as { functionResponse: { name: string } })
    .functionResponse.name, "list_storyboard");
  assert.equal((c[3].parts[0] as never as { functionResponse: { name: string } })
    .functionResponse.name, "update_scene");
});

test("gemini sends a systemInstruction rather than a system turn", async () => {
  const { http, seen } = spy({ candidates: [{ content: { parts: [{ text: "done" }] } }] });
  const out = await geminiTurn({ system: "you are the director", messages: [], model: "gemini-3-pro" }, http);
  assert.equal(seen[0].path, "/v1beta/models/gemini-3-pro:generateContent");
  assert.deepEqual(seen[0].body.systemInstruction, { parts: [{ text: "you are the director" }] });
  assert.equal(out.content, "done");
});

test("gemini tools go in a functionDeclarations wrapper", async () => {
  const { http, seen } = spy({ candidates: [{ content: { parts: [] } }] });
  await geminiTurn({ system: "s", messages: [], model: "m", tools: TOOLS }, http);
  const [group] = seen[0].body.tools as { functionDeclarations: { name: string }[] }[];
  assert.equal(group.functionDeclarations[0].name, "update_scene");
});

test("gemini reads a function call back into the shared shape", async () => {
  const out = await geminiTurn({ system: "s", messages: [], model: "m" },
    say({ candidates: [{ content: { parts: [
      { text: "ok " }, { functionCall: { name: "update_scene", args: { id: "S3" } } }] } }] }));
  assert.equal(out.content, "ok ");
  assert.deepEqual(out.tool_calls, [{ function: { name: "update_scene", arguments: { id: "S3" } } }]);
});

/* ── choosing ───────────────────────────────────────────────────────────── */

test("chatModels asks the key what it can see, and drops the non-chat rows", async () => {
  const ids = await chatModels("openai", say({ data: [
    { id: "gpt-5.6-luna" }, { id: "text-embedding-3-small" }, { id: "gpt-image-2" },
    { id: "whisper-1" }, { id: "gpt-4o-mini-tts" },
  ] }));
  assert.deepEqual(ids, ["gpt-5.6-luna"]);
});

test("gemini's list strips the models/ prefix the URL does not want back", async () => {
  const ids = await chatModels("google", say({ models: [
    { name: "models/gemini-3-pro", supportedGenerationMethods: ["generateContent"] },
    { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
  ] }));
  assert.deepEqual(ids, ["gemini-3-pro"]);
});

test("a failed listing is empty, not an exception — the default still works", async () => {
  const boom = (async () => { throw new Error("401"); }) as never;
  assert.deepEqual(await chatModels("anthropic", boom), []);
});

test("a backend id carries the model, and the bare provider form still parses", () => {
  const id = byokBackendId("google", "gemini-3.8-flash");
  assert.equal(id, "byok:google:gemini-3.8-flash");
  assert.equal(byokBackendProvider(id), "google");
  assert.equal(byokBackendModel(id), "gemini-3.8-flash");
  assert.equal(byokModelFor(id), "gemini-3.8-flash");

  // THE BARE FORM IS NOT LEGACY DEBT — `chat_threads.backend` holds whatever
  // answered a turn, so every thread opened before the picker named models
  // carries one, and one that stopped parsing would reopen pointed at nothing.
  assert.equal(byokBackendProvider("byok:google"), "google");
  assert.equal(byokBackendModel("byok:google"), null);
  assert.equal(byokModelFor("byok:google"), DEFAULT_CHAT_MODEL.google);

  // Not a BYOK id at all.
  for (const id of ["ollama-local", "claude-api", "byok:fal", undefined]) {
    assert.equal(byokBackendProvider(id), null, String(id));
    assert.equal(byokModelFor(id), "", String(id));
  }
});

test("a model id carrying its own colon survives the split", () => {
  // Split on the LAST colon (or on every one) and `qwen3:27b` becomes `qwen3`
  // — a model that does not exist, sent with nothing saying it was cut in half.
  const id = byokBackendId("openai", "local/qwen3:27b");
  assert.equal(byokBackendModel(id), "local/qwen3:27b");
  assert.equal(byokBackendProvider(id), "openai");
});

test("every offered model names a real provider and a non-empty id", () => {
  assert.ok(CHAT_MODELS.length >= 9, `only ${CHAT_MODELS.length} models offered`);
  const ids = new Set<string>();
  for (const m of CHAT_MODELS) {
    assert.ok(isChatProvider(m.provider), `${m.model}: '${m.provider}' is not a chat provider`);
    assert.ok(m.api && m.model && m.short && m.hint, `${m.model}: an empty field`);
    // A duplicate `api` within a provider would be two picker rows with ONE
    // backend id between them — the check mark would light both and the second
    // could never be selected.
    const id = byokBackendId(m.provider, m.api);
    assert.ok(!ids.has(id), `two rows share the backend id ${id}`);
    ids.add(id);
  }
  // The default has to be one of the models offered, or the bare-id fallback
  // sends something no row in the picker names.
  for (const p of CHAT_PROVIDERS) {
    assert.ok(CHAT_MODELS.some((m) => m.provider === p && m.api === DEFAULT_CHAT_MODEL[p]),
      `${p}'s default ${DEFAULT_CHAT_MODEL[p]} is not one of its offered models`);
  }
});

test("a model whose tools need Responses is routed there, and nothing else is", async () => {
  // GPT-6 Astra rejects `reasoning_effort: "none"` — the one value that gets
  // function tools past chat completions on a reasoning model — so its tools
  // go to the Responses endpoint. Routed on the TOOLS, not on the model: a
  // tool-less turn works on chat completions and `enhancePrompt` is one.
  const routed = CHAT_MODELS.find((m) => m.toolTransport);
  assert.ok(routed, "no model declares a tool transport — is the field gone?");
  assert.equal(toolTransport(routed!.api), "responses");
  assert.equal(toolTransport(`${routed!.api}-2026-09-03`), "responses", "not prefix-matched");
  assert.equal(toolTransport("claude-opus-5"), "chat");
  assert.equal(toolTransport("gpt-5.6-luna"), "chat");

  const seen: string[] = [];
  const http = (async (_p: string, path: string) => {
    seen.push(path);
    return { output: [], choices: [{ message: { content: "" } }] };
  }) as never;
  const req = { system: "s", messages: [{ role: "user", content: "hi" }] };
  await openaiTurn({ ...req, model: routed!.api, tools: TOOLS }, http);
  await openaiTurn({ ...req, model: routed!.api }, http);
  await openaiTurn({ ...req, model: "gpt-5.6-luna", tools: TOOLS }, http);
  assert.deepEqual(seen, ["/v1/responses", "/v1/chat/completions", "/v1/chat/completions"]);
});

test("the Responses body is that dialect, not the other one wearing its url", async () => {
  let body: Record<string, unknown> = {};
  const http = (async (_p: string, _path: string, init: { body: Record<string, unknown> }) => {
    body = init.body;
    return { output: [] };
  }) as never;
  await openaiResponsesTurn(
    { system: "you are the director", messages: CONVO, model: "gpt-6-astra", tools: TOOLS }, http);
  // There is no system ROLE here.
  assert.equal(body.instructions, "you are the director");
  assert.ok(!("messages" in body), "chat-completions messages leaked");
  // FLAT tools — nested under `function`, every field is one the endpoint does
  // not declare, i.e. a turn with no tools at all.
  assert.deepEqual(Object.keys((body.tools as Record<string, unknown>[])[0]).sort(),
                   ["description", "name", "parameters", "type"]);
  assert.equal(body.tool_choice, "auto");
  // The user's storyboard must not sit on a third party's servers for 30 days.
  assert.equal(body.store, false);
});

test("the history becomes input items, paired by a call_id minted here", () => {
  // The loop's neutral history has no ids — the pairing is POSITIONAL, exactly
  // as it is for Anthropic and Gemini — so the id linking a call to its result
  // is minted in this function and has to be minted consistently.
  const input = responsesInput([
    { role: "user", content: "make a shot" },
    { role: "assistant", content: "on it",
      tool_calls: [{ function: { name: "add_block", arguments: { x: 1 } } }] },
    { role: "tool", content: '{"ok":true}' },
  ]) as Record<string, unknown>[];
  assert.deepEqual(input[0], { role: "user", content: "make a shot" });
  assert.deepEqual(input[1], { role: "assistant", content: "on it" });
  assert.equal(input[2].type, "function_call");
  assert.equal(input[2].name, "add_block");
  // A STRING, always: the history carries an object from Ollama and a string
  // from chat completions, and this field is documented as JSON text.
  assert.equal(input[2].arguments, '{"x":1}');
  assert.equal(input[3].type, "function_call_output");
  assert.equal(input[3].call_id, input[2].call_id, "the result answers a different call");
});

test("a result with nothing to answer is dropped, not sent", () => {
  // An unmatched `call_id` is a 400 on the whole turn — `anthropicMessages`'
  // rule, one dialect over.
  const input = responsesInput([{ role: "tool", content: "orphan" }]);
  assert.deepEqual(input, []);
});

test("two calls in one message get two ids, and a message between does not shift them", () => {
  const input = responsesInput([
    { role: "assistant", content: "first",
      tool_calls: [{ function: { name: "a", arguments: {} } },
                   { function: { name: "b", arguments: {} } }] },
    { role: "tool", content: "ra" },
    { role: "tool", content: "rb" },
  ]) as Record<string, unknown>[];
  const calls = input.filter((i) => i.type === "function_call");
  const outs = input.filter((i) => i.type === "function_call_output");
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].call_id, calls[1].call_id, "two calls share one id");
  assert.equal(outs[0].call_id, calls[0].call_id);
  assert.equal(outs[1].call_id, calls[1].call_id);
});

test("the reply is read out of `output`, and a reasoning item is not the reply", () => {
  // It arrives in the same array as the message; concatenating it would put
  // the model's private thinking into the transcript.
  const m = responsesMessage([
    { type: "reasoning" },
    { type: "message", content: [{ type: "output_text", text: "the answer" }] },
    { type: "function_call", call_id: "c1", name: "add_block", arguments: '{"x":1}' },
  ]);
  assert.equal(m.content, "the answer");
  assert.deepEqual(m.tool_calls, [{ function: { name: "add_block", arguments: '{"x":1}' } }]);
});

test("the tool converters are not interchangeable", () => {
  const [resp] = responsesTools(TOOLS) as Record<string, unknown>[];
  assert.equal(resp.type, "function");
  assert.equal(resp.name, (TOOLS[0] as { function: { name: string } }).function.name);
  assert.ok(!("function" in resp), "responses tools are flat");
});

test("chatFor binds the provider and falls back to that provider's default", async () => {
  assert.equal(isChatProvider("anthropic"), true);
  assert.equal(isChatProvider("fal"), false);
  for (const p of ["anthropic", "openai", "google"] as const) {
    assert.ok(DEFAULT_CHAT_MODEL[p], `${p} has no default model`);
  }
  const fn = chatFor("anthropic", "");
  assert.equal(typeof fn, "function");
});

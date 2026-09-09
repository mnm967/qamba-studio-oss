import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  asOllamaTools, localDirectorBlocker, parseLooseToolCall, turnBlocks,
} from "./localDirectorRules.ts";
import { TOOLS, TOOL_NAMES } from "../../director/tools.js";

test("the schema lands on `parameters`, which is where Ollama looks", () => {
  // Anthropic says `input_schema`, Ollama says `function.parameters`. Passed
  // through unconverted the model is handed tools with NO arguments — it calls
  // them with nothing in them and every one reports a missing required field.
  const out = asOllamaTools([
    { name: "update_beat", description: "d", input_schema: { type: "object", properties: { x: {} } } },
  ]);
  assert.equal(out[0].type, "function");
  assert.equal(out[0].function.name, "update_beat");
  assert.deepEqual(out[0].function.parameters, { type: "object", properties: { x: {} } });
});

test("the real toolset converts whole, and every tool keeps its schema", () => {
  // Guards the seam rather than a fixture: this is the ACTUAL array the
  // hosted director uses, imported from the module both now share.
  const out = asOllamaTools(TOOLS as never);
  assert.ok(out.length > 30, `expected the full toolset, got ${out.length}`);
  for (const t of out) {
    assert.ok(t.function.name, "a tool with no name");
    assert.ok(t.function.description, `${t.function.name} has no description`);
    assert.ok(t.function.parameters, `${t.function.name} lost its schema`);
  }
});

test("a LOCAL project is no longer a reason to refuse", () => {
  // It was the reason this function existed: the tools fetched PostgREST
  // directly, so on a project whose rows are a file they would have edited the
  // studio's copy of it. `localDirector`'s db routes through `localRest` now,
  // so the plane is not a question the model getter has to ask — and the
  // parameter is gone rather than ignored, so a caller still passing one is a
  // type error rather than a silently dead argument.
  const decl = readFileSync(new URL("./localDirectorRules.ts", import.meta.url), "utf8");
  const fn = /export function localDirectorBlocker\([\s\S]*?\n\}/.exec(decl)?.[0] ?? "";
  assert.ok(fn, "localDirectorBlocker not found");
  assert.ok(!/localProject/.test(fn), "the local-project refusal is still there");
});

test("the web build and a machine with no model are refused, each in its own words", () => {
  assert.match(localDirectorBlocker({ desktop: false, model: "m" }) ?? "", /web build/);
  assert.match(localDirectorBlocker({ desktop: true, model: null }) ?? "", /no local model/);
});

test("the desktop with a model installed is allowed", () => {
  assert.equal(
    localDirectorBlocker({ desktop: true, model: "huihui_ai/qwen3-abliterated:8b" }),
    null);
});

test("the transcript blocks match what the worker writes, so one renderer serves both", () => {
  const blocks = turnBlocks([{ name: "update_beat", ok: true }], "done");
  assert.deepEqual(blocks, [
    { type: "tool_use", name: "update_beat" },
    { type: "tool_result", name: "update_beat" },
    { type: "text", text: "done" },
  ]);
  // The text block is always last — the dock renders tools above the reply.
  const withFail = turnBlocks([{ name: "x", ok: false }], "partly");
  assert.equal(withFail[withFail.length - 1].type, "text");
  assert.equal(withFail[1].error, true);
});

test("a tool call the model wrote as TEXT is recovered", () => {
  // Verbatim from huihui_ai/qwen3-abliterated:8b handed all 38 tools: the right
  // tool, the right arguments, and no `<tool_call>` wrapper for Ollama's parser
  // to find — so `tool_calls` came back empty and the turn did nothing.
  const got = parseLooseToolCall('{"name": "list_storyboard", "arguments": {}}', TOOL_NAMES as Set<string>);
  assert.deepEqual(got, { name: "list_storyboard", arguments: {} });
});

test("an INVENTED tool name is refused, not run", () => {
  // Also verbatim from the same model: asked to add a character it emitted
  // `add_character`, which does not exist (the real one is
  // update_bible_entry). Running an invented name is worse than ignoring it.
  assert.equal(
    parseLooseToolCall('{"name": "add_character", "arguments": {"name": "Vera"}}', TOOL_NAMES as Set<string>),
    null);
  assert.equal(parseLooseToolCall('{"name": "list_scenes", "arguments": {}}', TOOL_NAMES as Set<string>), null);
});

test("ordinary prose is never mistaken for a call", () => {
  const names = TOOL_NAMES as Set<string>;
  for (const text of [
    "Sure — I'll update that scene for you.",
    "",
    "{ not json",
    '["list_storyboard"]',
    '{"arguments": {}}',
    '{"name": 7}',
  ]) assert.equal(parseLooseToolCall(text, names), null, `matched: ${text}`);
});

test("`parameters` is accepted as well as `arguments`, and a non-object degrades to {}", () => {
  // Small models mix the two spellings; neither is worth losing a call over.
  assert.deepEqual(
    parseLooseToolCall('{"name":"list_storyboard","parameters":{"scene_id":"S2"}}', TOOL_NAMES as Set<string>),
    { name: "list_storyboard", arguments: { scene_id: "S2" } });
  assert.deepEqual(
    parseLooseToolCall('{"name":"list_storyboard","arguments":"nope"}', TOOL_NAMES as Set<string>),
    { name: "list_storyboard", arguments: {} });
});

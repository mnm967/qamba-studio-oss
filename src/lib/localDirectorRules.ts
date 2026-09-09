// The pure half of the desktop director: what it may run, and the one shape
// conversion its transport needs.
//
// Its own module for the reason `panelSpec.ts` is: `localDirector.ts` imports
// the Supabase client, which builds itself at module load and cannot be
// imported by `node --test`. These are the decisions worth pinning, so they
// live where a test can reach them.

/** An Anthropic-shaped tool definition — what `director/tools.js` exports. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: unknown;
}

/**
 * Anthropic's tool shape to Ollama's.
 *
 * The same job `asOpenAITools` does for the hosted OpenAI path, and the same
 * trap: the schema key is `parameters` here and `input_schema` there. Get it
 * wrong and the model is handed tools with no arguments — it calls them, with
 * nothing in them, and every tool reports a missing required field.
 */
export function asOllamaTools(tools: ToolDef[]) {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/**
 * Why a local director turn cannot run, or null when it can.
 *
 * A LOCAL PROJECT IS NO LONGER ONE OF THE REASONS, and that was the biggest of
 * the three. The toolset reached PostgREST directly, so pointed at a project
 * whose rows are a file on this machine it would have read and written the
 * STUDIO's copy — every tool reporting success while editing a storyboard that
 * is not the one on screen. `localDirector`'s db goes through `localRest` now,
 * which answers the same paths out of that project's own store, so the two
 * questions left are about the MACHINE rather than the project.
 *
 * (The refusal it used to return was also never wired to anything — all three
 * chat surfaces reached the routing question instead, where a local project
 * went to `/api/director/*` and got a 404. That is `routeHere`'s job now.)
 */
export function localDirectorBlocker(opts: {
  desktop: boolean;
  model: string | null;
}): string | null {
  if (!opts.desktop) return "the desktop app runs local turns; this is the web build";
  if (!opts.model) {
    return "no local model is installed — add one in the local engine screen";
  }
  return null;
}

/**
 * The transcript blocks a finished local turn should carry.
 *
 * Mirrors what the worker writes (`tool_use` / `tool_result` blocks, then the
 * text) so the dock renders a local turn and a pod turn identically — there is
 * one transcript renderer and it reads `chat_messages`, not a transport.
 */
export function turnBlocks(
  calls: { name: string; ok: boolean }[],
  text: string,
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const c of calls) {
    blocks.push({ type: "tool_use", name: c.name });
    blocks.push({ type: "tool_result", name: c.name, ...(c.ok ? {} : { error: true }) });
  }
  blocks.push({ type: "text", text });
  return blocks;
}

/**
 * A tool call the model emitted as TEXT instead of as a structured call.
 *
 * MEASURED, not defensive coding. `huihui_ai/qwen3-abliterated:8b` calls tools
 * correctly with 1, 5 or 12 of them offered and stops at the full 38: it still
 * picks the right tool and the right arguments, but drops the `<tool_call>`
 * wrapper Qwen3's parser needs, so Ollama has nothing to put in `tool_calls`
 * and the whole thing arrives as a sentence. The turn then does nothing and
 * says it did — the exact failure a director with tools exists to avoid.
 *
 * Two guards keep this from firing on ordinary prose: the text must parse as
 * one JSON object, and its `name` must be a tool that ACTUALLY EXISTS. A model
 * under load also invents plausible names (`list_scenes`, `add_character` were
 * both observed), and running an invented name is worse than ignoring it —
 * unrecognised, it falls through and is shown to the user as the reply it
 * appears to be.
 */
export function parseLooseToolCall(
  content: string,
  known: Set<string> | string[],
): { name: string; arguments: Record<string, unknown> } | null {
  const names = known instanceof Set ? known : new Set(known);
  const text = String(content ?? "").trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as { name?: unknown; arguments?: unknown; parameters?: unknown };
  if (typeof o.name !== "string" || !names.has(o.name)) return null;
  const raw = o.arguments ?? o.parameters ?? {};
  const args = (raw && typeof raw === "object" && !Array.isArray(raw))
    ? raw as Record<string, unknown>
    : {};
  return { name: o.name, arguments: args };
}

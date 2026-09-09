// Replaying a chat turn as text, without throwing away what the turn DID.
//
// History was rebuilt from `type: "text"` blocks only, so a director that spent
// its last turn queuing three re-renders came back the next turn with no record
// of having done anything — it re-read the storyboard, re-queued the same work,
// or told the user it could not remember. Everything it needs is already
// persisted beside the text (`tool_use` + `tool_result` blocks); it just never
// reached the model.
//
// Full tool JSON is not the answer: a `list_storyboard` result is a whole
// episode, and thirty messages of those blow the context before the
// conversation starts. So each call collapses to ONE line naming the tool and
// its outcome — enough to know it happened and what it produced, cheap enough
// to keep thirty of them.
//
// Plain JS, no imports: read by the serverless functions and by `node --test`.

/** How much of a tool error survives into the one-liner. */
const ERR_CHARS = 80;

/**
 * The outcome half of the line: what this call actually produced.
 *
 * Ordered by what a reader needs first — a failure, then an id worth following
 * up (get_job takes one), then the bare fact that it worked.
 *
 * @param {any} result the tool's own return value
 * @returns {string}
 */
export function outcomeOf(result) {
  if (result == null) return "ok";
  if (typeof result !== "object") return "ok";
  if (result.error) return `error: ${String(result.error).replace(/\s+/g, " ").slice(0, ERR_CHARS)}`;
  const id = result.job_id || result.sheet_job_id || result.voice_ref_job_id;
  if (id) return `job ${String(id).slice(0, 8)}`;
  if (Array.isArray(result.queued) && result.queued.length) {
    return `queued ${result.queued.length} block(s)`;
  }
  if (result.dry_run) return "dry run — nothing queued";
  if (result.choice) return "offered the user a choice";
  const made = result.created_entry_id || result.proposed_revision_id
    || result.created_scene_id || result.created_beat_id || result.block_id || result.take_id;
  if (made) return `${String(made).slice(0, 8)}`;
  return "ok";
}

/** One replayed tool call. */
export const toolNote = (name, result) => `[tool ${name} → ${outcomeOf(result)}]`;

/**
 * Attachments replay as their ids, because the ids are what tools take.
 * The picture itself is only re-sent for the turn it arrived on (an image
 * block per history message would cost more than the whole conversation).
 */
function refNote(block) {
  if (block.type === "asset_ref") {
    return `[attached ${block.media || "asset"} ${block.asset_id}` +
           `${block.label ? ` — ${block.label}` : ""}]`;
  }
  return `[attached block ${block.label || block.block_id}` +
         `${block.block_id && block.label ? ` (${block.block_id})` : ""}]`;
}

/**
 * A persisted `chat_messages.content` array -> the text that stands in for it.
 *
 * Handles both persisted shapes: the Claude path stores `tool_use.id` +
 * `tool_result.tool_use_id`, the OpenAI path stores neither, so results are
 * paired by id when there is one and by order-within-name when there is not.
 * A `tool_use` with no result at all (the turn died mid-round) still gets a
 * line — "it was attempted" is information too.
 *
 * @param {Array<Record<string, any>>|null|undefined} content
 * @returns {string}
 */
export function summarizeContent(content) {
  const blocks = Array.isArray(content) ? content : [];
  const results = blocks.filter((b) => b?.type === "tool_result");
  const used = new Set();

  const resultFor = (call) => {
    const byId = call.id
      ? results.find((r, i) => !used.has(i) && r.tool_use_id === call.id)
      : null;
    if (byId) { used.add(results.indexOf(byId)); return byId.result; }
    const i = results.findIndex((r, j) => !used.has(j) && r.name === call.name);
    if (i < 0) return undefined;
    used.add(i);
    return results[i].result;
  };

  const lines = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && String(b.text || "").trim()) lines.push(String(b.text).trim());
    else if (b.type === "tool_use") lines.push(toolNote(b.name, resultFor(b)));
    else if (b.type === "asset_ref" || b.type === "block_ref") lines.push(refNote(b));
  }
  return lines.join("\n").trim();
}

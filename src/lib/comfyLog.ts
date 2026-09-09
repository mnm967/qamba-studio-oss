// ComfyUI's own log, as plain text.
//
// PURE AND DEPENDENCY-FREE so `node --test` can pin it: `comfyLocal.ts` reaches
// the supabase client by way of `db/customWorkflows`, which takes the whole
// module out of the suite. The same split, for the same reason, as
// `driftProfile.ts` beside the player.
//
// The SHAPE is the half that goes wrong quietly, which is why it is pinned at
// all: each entry already ends in its own newline (so joining on one more
// double-spaces the panel), the text is ANSI-coloured (a `<pre>` renders that
// as garbage rather than as colour), and an engine too old to have the
// endpoint answers 200 with something else rather than 404.

/** ANSI colour, as ComfyUI writes it — `[INFO]` arrives wrapped in escapes. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** What `/internal/logs/raw` returns. */
export interface ComfyLogBody {
  entries?: Array<{ t?: string; m?: string } | string>;
}

/** The last `lines` lines of `/internal/logs/raw`, as plain text.
 *
 *  Anything unexpected returns "" — an empty panel is exactly what a linked
 *  engine showed before this existed, so the worst outcome is the status quo
 *  rather than a thrown error inside a polling loop. */
export function formatComfyLog(body: unknown, lines = 60): string {
  const entries = (body as ComfyLogBody | null)?.entries;
  if (!Array.isArray(entries)) return "";
  const out = entries
    .map((e) => (typeof e === "string" ? e : String(e?.m ?? "")))
    .join("")
    .replace(ANSI, "")
    .split("\n");
  // The last entry ends in a newline too, so the split leaves a trailing "".
  // Dropping it BEFORE the tail is the whole point: left in, it eats one of
  // the `lines` slots and the panel shows N-1 lines and a blank.
  if (out.length && out[out.length - 1] === "") out.pop();
  return out.slice(-lines).join("\n");
}

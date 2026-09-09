// Where a ComfyUI render has got to, read out of the engine's own log.
//
// WHY NOT THE WEBSOCKET. Progress is the one thing ComfyUI does not expose
// over HTTP — history, outputs and the queue are all pollable, sampler
// progress is pushed over `/ws` and nowhere else. The pod's worker holds that
// socket (`comfy._PreviewTap`); the desktop webview cannot, because ComfyUI's
// `origin_only_middleware` refuses a foreign Origin and a browser WebSocket
// sends its own — the same wall `comfyHeaders` exists to get over for plain
// HTTP, minus the ability to get over it. So the sampler's tqdm output is the
// signal, and `engine_log` already hands it over.
//
// This is its OWN module so it can be tested. `localRender.ts` reaches
// Supabase and the upload routes at import time, and neither exists under
// `node --test`; a parser whose wrong answers are invisible (a bar stuck at
// 0%, or one that reports a timestamp as a step count) is exactly the code
// that has to stay reachable from a test.

/**
 * The sampler's position, or null.
 *
 * tqdm rewrites one line with `\r`, so by the time the log is split on `\n` a
 * whole render is a single line and every step it has taken is still in it —
 * the LAST match is the current one. Anything unparseable is null and the
 * caller falls back to elapsed time: a bar at a wrong number is worse than a
 * bar that admits it does not know.
 */
export function progressFromLog(tail: string): { done: number; total: number } | null {
  // The trailing `[` is what separates a step count from everything else tqdm
  // prints on the same line — `07:48` is a clock and `93.61s/it` is a rate,
  // and both sit inside the bracket this anchors on.
  const re = /(\d+)\/(\d+)\s*\[/g;
  let m: RegExpExecArray | null;
  let last: { done: number; total: number } | null = null;
  while ((m = re.exec(tail)) !== null) {
    const done = Number(m[1]);
    const total = Number(m[2]);
    if (total > 0 && done <= total) last = { done, total };
  }
  return last;
}
